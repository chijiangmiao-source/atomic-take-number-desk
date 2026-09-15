import { expect, test } from '@playwright/test';

// 场景：提交后服务在“落库后、回包前”崩溃（注入故障返回 503）。
// 页面必须保留待重试操作；刷新页面后仍保留；服务恢复后重试取回唯一镜号。
test('注入故障后保留待重试操作，恢复后重试显示唯一镜号', async ({ page }) => {
  await page.goto('/');

  await page.getByTestId('scene-input').fill('E2E-RETRY');
  await page.getByTestId('notes-input').fill('雨夜追车长镜头');
  await page.getByTestId('inject-toggle').check();
  await page.getByTestId('submit-button').click();

  // 注入故障生效：出现待重试操作，并展示 503 错误反馈
  const pendingList = page.getByTestId('pending-list');
  await expect(pendingList).toBeVisible();
  await expect(pendingList).toContainText('E2E-RETRY');
  await expect(pendingList).toContainText('雨夜追车长镜头');
  await expect(pendingList.getByTestId('pending-error')).toContainText('503');

  // 刷新页面：待重试操作仍然保留（本地持久化）
  await page.reload();
  const pendingAfterReload = page.getByTestId('pending-list');
  await expect(pendingAfterReload).toBeVisible();
  await expect(pendingAfterReload).toContainText('雨夜追车长镜头');

  // 服务已恢复：重试取回最初提交的镜号 #1
  await page.getByTestId('retry-button').click();
  await expect(page.getByTestId('shot-number-value')).toHaveText('#1');
  await expect(page.getByTestId('pending-card')).toHaveCount(0);

  // 再领一条新镜号：号码连续为 #2，证明故障没有造成缺号或重号
  await page.getByTestId('regenerate-op-id').click();
  await page.getByTestId('notes-input').fill('第二条镜头');
  await page.getByTestId('submit-button').click();
  await expect(page.getByTestId('shot-number-value')).toHaveText('#2');

  // 场次看板列出两条记录
  const board = page.getByTestId('scene-board');
  await expect(board.getByTestId('scene-op-row')).toHaveCount(2);
  await expect(board).toContainText('雨夜追车长镜头');
  await expect(board).toContainText('第二条镜头');
});

// 场景：同一操作重复提交（双击/重发），服务器幂等返回同一号码。
test('相同操作标识与内容重复提交返回同一镜号', async ({ page }) => {
  await page.goto('/');

  await page.getByTestId('scene-input').fill('E2E-IDEMPOTENT');
  await page.getByTestId('notes-input').fill('开场空镜');
  await page.getByTestId('submit-button').click();
  await expect(page.getByTestId('shot-number-value')).toHaveText('#1');

  // 不改动任何内容再次提交（操作标识保持不变）
  await page.getByTestId('submit-button').click();
  await expect(page.getByTestId('shot-number-value')).toHaveText('#1');
  await expect(page.getByTestId('replayed-badge')).toBeVisible();

  // 场次看板仍然只有一条记录
  await expect(page.getByTestId('scene-board').getByTestId('scene-op-row')).toHaveCount(1);
});
