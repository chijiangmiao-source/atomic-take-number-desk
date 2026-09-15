import { expect, test, type Page } from '@playwright/test';

// 端到端复现多部门交接时的流水回看：分页续页、断网保留已显示内容并就地重试、
// 浏览期间的新事件刷新后才出现；同时验证旧的场次看板与行内编辑不受影响。
//
// 注意：e2e 全程打真实 API（共享一个数据库，两个 worker 并行），
// 因此断言一律以“本用例唯一场次/备注”为锚，不假设全局事件总数。

function uniqueScene(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seedIssue(
  page: Page,
  scene: string,
  notes: string,
): Promise<{ client_op_id: string; shot_number: number }> {
  const resp = await page.request.post('/api/shot-numbers', {
    data: { scene_id: scene, client_op_id: crypto.randomUUID(), notes },
  });
  expect(resp.ok()).toBeTruthy();
  return (await resp.json()) as { client_op_id: string; shot_number: number };
}

async function seedUpdate(
  page: Page,
  opId: string,
  baseRevision: number,
  notes: string,
): Promise<void> {
  const resp = await page.request.post(`/api/operations/${opId}/notes`, {
    data: { base_revision: baseRevision, notes },
  });
  expect(resp.ok()).toBeTruthy();
}

/** 滚动到底逐页加载，直到出现“已到底”标记。 */
async function drainFeed(page: Page): Promise<void> {
  const scroll = page.getByTestId('feed-scroll');
  for (let round = 0; round < 40; round += 1) {
    if (await page.getByTestId('feed-end').isVisible()) return;
    await scroll.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await page.waitForTimeout(150);
  }
  throw new Error('流水未在预期时间内翻到底');
}

test('流水分页加载：断网保留已显示内容与原游标，恢复后就地续页', async ({ page }) => {
  const scene = uniqueScene('E2E-FEED-A');
  // 27 次领取 + 3 次修订 = 30 条本用例事件（超过一页 25 条）
  const opIds: string[] = [];
  for (let i = 1; i <= 27; i += 1) {
    const issued = await seedIssue(page, scene, `A-镜头${i}`);
    opIds.push(issued.client_op_id);
  }
  for (let i = 1; i <= 3; i += 1) {
    await seedUpdate(page, opIds[i - 1], 1, `A-改-${i}`);
  }

  await page.goto('/');
  const feed = page.getByTestId('event-feed');
  const rows = feed.getByTestId('feed-row');

  // 首屏：固定当次浏览快照的第一页（每页 25 条）
  await expect(rows).toHaveCount(25);
  await expect(feed.getByTestId('feed-count')).toContainText('25');
  const firstRowText = await rows.first().textContent();

  // 断网：滚动到底触发续页，加载失败
  await page.route('**/api/events*', (route) => route.abort());
  await page.getByTestId('feed-scroll').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect(page.getByTestId('feed-error')).toBeVisible();

  // 已显示内容原样保留（首行不变、条数不变），原游标未丢
  await expect(rows).toHaveCount(25);
  await expect(rows.first()).toHaveText(firstRowText ?? '');

  // 恢复网络，就地重试：从原游标继续，直到翻完整个快照
  await page.unroute('**/api/events*');
  await page.getByTestId('feed-retry').click();
  await expect(page.getByTestId('feed-error')).toBeHidden();
  await drainFeed(page);
  await expect(page.getByTestId('feed-end')).toBeVisible();

  // 本用例的 30 条事件全部在列；全局序号无重复且严格倒序（无重无漏）
  await expect(rows.filter({ hasText: scene })).toHaveCount(30);
  const seqTexts = await feed.getByTestId('feed-seq').allTextContents();
  const seqs = seqTexts.map(Number);
  expect(new Set(seqs).size).toBe(seqs.length);
  expect([...seqs].sort((a, b) => b - a)).toEqual(seqs);

  // 行内容：修订行展示场次、镜号、事件类型、修订号、当时备注与发生时间
  const revisedRow = rows.filter({ hasText: 'A-改-2' });
  await expect(revisedRow.getByTestId('feed-scene')).toHaveText(scene);
  await expect(revisedRow.getByTestId('feed-shot')).toHaveText('#2');
  await expect(revisedRow.getByTestId('feed-event-type')).toHaveText('备注修订');
  await expect(revisedRow.getByTestId('feed-revision')).toHaveText('r2');
  await expect(revisedRow.getByTestId('feed-notes')).toHaveText('A-改-2');
  await expect(revisedRow.getByTestId('feed-time')).not.toBeEmpty();

  // 领取行：修订号恒为 r1，镜号与发放一致
  const issuedRow = rows.filter({ hasText: 'A-镜头7' });
  await expect(issuedRow.getByTestId('feed-event-type')).toHaveText('领取');
  await expect(issuedRow.getByTestId('feed-revision')).toHaveText('r1');
  await expect(issuedRow.getByTestId('feed-shot')).toHaveText('#7');
});

test('浏览期间的新事件刷新流水后才出现，场次看板与行内编辑保持可用', async ({ page }) => {
  const scene = uniqueScene('E2E-FEED-B');
  const op1 = await seedIssue(page, scene, 'B-镜头1');
  await seedIssue(page, scene, 'B-镜头2');
  await seedIssue(page, scene, 'B-镜头3');

  await page.goto('/');
  const feed = page.getByTestId('event-feed');
  await drainFeed(page);
  await expect(feed.getByTestId('feed-row').filter({ hasText: scene })).toHaveCount(3);

  // 浏览期间：另一终端写入 2 条新事件（1 领取 + 1 修订）
  await seedIssue(page, scene, 'B-新领取');
  await seedUpdate(page, op1.client_op_id, 1, 'B-新修订');

  // 未刷新：新事件不进入本次浏览快照
  await page.waitForTimeout(500);
  await expect(feed.getByTestId('feed-row').filter({ hasText: 'B-新领取' })).toHaveCount(0);
  await expect(feed.getByTestId('feed-row').filter({ hasText: 'B-新修订' })).toHaveCount(0);

  // 刷新流水：固定新快照，新事件出现
  await page.getByTestId('feed-refresh').click();
  await drainFeed(page);
  await expect(feed.getByTestId('feed-row').filter({ hasText: 'B-新领取' })).toHaveCount(1);
  await expect(feed.getByTestId('feed-row').filter({ hasText: 'B-新修订' })).toHaveCount(1);
  await expect(feed.getByTestId('feed-row').filter({ hasText: scene })).toHaveCount(5);

  // 旧的场次看板：同场景 4 条镜号，行内编辑体验不变
  await page.getByTestId('scene-input').fill(scene);
  const board = page.getByTestId('scene-board');
  await expect(board.getByTestId('scene-op-row')).toHaveCount(4);
  const firstRow = board.getByTestId('scene-op-row').first();
  await firstRow.getByTestId('note-edit-button').click();
  await page.getByTestId('note-editor').fill('B-看板行内改');
  await page.getByTestId('note-save-button').click();
  await expect(firstRow.getByTestId('note-revision')).toHaveText('r3');
  await expect(firstRow).toContainText('B-看板行内改');

  // 行内编辑产生的新修订事件：刷新流水后可见，且类型为备注修订
  await page.getByTestId('feed-refresh').click();
  await drainFeed(page);
  const editedRow = feed.getByTestId('feed-row').filter({ hasText: 'B-看板行内改' });
  await expect(editedRow).toHaveCount(1);
  await expect(editedRow.getByTestId('feed-event-type')).toHaveText('备注修订');
  await expect(editedRow.getByTestId('feed-revision')).toHaveText('r3');
});
