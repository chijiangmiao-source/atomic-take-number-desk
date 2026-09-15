import { expect, test } from '@playwright/test';

// 场景：场记发放镜号后，从场次看板行内编辑备注并保存。
// 镜号不变，修订号递增，看板展示最新文本。
test('看板行内编辑备注并保存：镜号不变、修订号递增', async ({ page }) => {
  await page.goto('/');

  await page.getByTestId('scene-input').fill('E2E-NOTES');
  await page.getByTestId('notes-input').fill('第一行\n第二行\n第三行');
  await page.getByTestId('submit-button').click();
  await expect(page.getByTestId('shot-number-value')).toHaveText('#1');

  const row = page.getByTestId('scene-board').getByTestId('scene-op-row');
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('note-revision')).toHaveText('r1');

  await row.getByTestId('note-edit-button').click();
  await page.getByTestId('note-editor').fill('第一行\n第二行改\n第三行');
  await page.getByTestId('note-save-button').click();

  // 保存后回到静态行：新文本、r2，镜号仍是 #1
  await expect(row.getByTestId('note-revision')).toHaveText('r2');
  await expect(row).toContainText('第二行改');
  await expect(row.locator('.num')).toHaveText('#1');
});

// 场景：两台终端基于同一修订编辑不同行——后到者的保存被服务端按行三方合并，
// 只产生一个新修订，双方改动都在。
test('两终端不相交编辑自动合并为一个新修订', async ({ page }) => {
  await page.goto('/');

  await page.getByTestId('scene-input').fill('E2E-MERGE');
  await page.getByTestId('notes-input').fill('第一行\n第二行\n第三行');
  const opId = await page.getByTestId('op-id-input').inputValue();
  await page.getByTestId('submit-button').click();
  await expect(page.getByTestId('shot-number-value')).toHaveText('#1');

  const row = page.getByTestId('scene-board').getByTestId('scene-op-row');
  // 本终端基于 r1 开始编辑（先锁定基础修订号）
  await row.getByTestId('note-edit-button').click();

  // 另一终端直接通过 API 把第一行改掉：服务端前进到 r2
  const other = await page.request.post(`/api/operations/${opId}/notes`, {
    data: { base_revision: 1, notes: '一改\n第二行\n第三行' },
  });
  expect(other.ok()).toBeTruthy();

  // 本终端改第三行并保存：与 r2 不相交 → 自动合并为 r3
  await page.getByTestId('note-editor').fill('第一行\n第二行\n三改');
  await page.getByTestId('note-save-button').click();

  await expect(row.getByTestId('note-revision')).toHaveText('r3');
  await expect(row).toContainText('一改');
  await expect(row).toContainText('三改');
  await expect(row.locator('.num')).toHaveText('#1');
});

// 场景：两台终端改了同一行——服务端返回 409 与三方片段，本地输入保留；
// 场记对照整理后再次保存成功。
test('重叠编辑返回冲突并保留输入，整理后再次保存成功', async ({ page }) => {
  await page.goto('/');

  await page.getByTestId('scene-input').fill('E2E-NOTE-CONFLICT');
  await page.getByTestId('notes-input').fill('第一行\n第二行\n第三行');
  const opId = await page.getByTestId('op-id-input').inputValue();
  await page.getByTestId('submit-button').click();
  await expect(page.getByTestId('shot-number-value')).toHaveText('#1');

  const row = page.getByTestId('scene-board').getByTestId('scene-op-row');
  await row.getByTestId('note-edit-button').click();

  // 另一终端把第二行改掉：服务端前进到 r2
  const other = await page.request.post(`/api/operations/${opId}/notes`, {
    data: { base_revision: 1, notes: '第一行\n服务端改动\n第三行' },
  });
  expect(other.ok()).toBeTruthy();

  // 本终端基于 r1 改同一行 → 重叠 → 冲突面板
  await page.getByTestId('note-editor').fill('第一行\n本地改动\n第三行');
  await page.getByTestId('note-save-button').click();

  const panel = page.getByTestId('note-conflict-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('conflict-server')).toContainText('服务端改动');
  await expect(panel.getByTestId('conflict-local')).toContainText('本地改动');
  // 本地输入原样保留在编辑框里
  await expect(page.getByTestId('note-editor')).toHaveValue('第一行\n本地改动\n第三行');

  // 场记对照三方文本整理后再次保存 → 成功，前进到 r3
  await page.getByTestId('note-editor').fill('第一行\n服务端+本地整理稿\n第三行');
  await page.getByTestId('note-save-button').click();
  await expect(row.getByTestId('note-revision')).toHaveText('r3');
  await expect(row).toContainText('服务端+本地整理稿');
  await expect(row.locator('.num')).toHaveText('#1');
});

// 场景：保存时网络失败——输入保留并提示；网络恢复后再次保存成功。
test('保存备注时网络失败保留输入，恢复后再次保存成功', async ({ page }) => {
  await page.goto('/');

  await page.getByTestId('scene-input').fill('E2E-NOTE-NETWORK');
  await page.getByTestId('notes-input').fill('原始备注');
  await page.getByTestId('submit-button').click();
  await expect(page.getByTestId('shot-number-value')).toHaveText('#1');

  const row = page.getByTestId('scene-board').getByTestId('scene-op-row');
  await row.getByTestId('note-edit-button').click();
  await page.getByTestId('note-editor').fill('网络恢复后要保存的文本');

  // 模拟网络中断：保存请求发不出去
  await page.route('**/api/operations/*/notes', (route) => route.abort());
  await page.getByTestId('note-save-button').click();

  // 失败反馈 + 输入保留
  await expect(page.getByTestId('note-save-error')).toBeVisible();
  await expect(page.getByTestId('note-editor')).toHaveValue('网络恢复后要保存的文本');

  // 网络恢复：再次保存成功，前进到 r2
  await page.unroute('**/api/operations/*/notes');
  await page.getByTestId('note-save-button').click();
  await expect(row.getByTestId('note-revision')).toHaveText('r2');
  await expect(row).toContainText('网络恢复后要保存的文本');
  await expect(row.locator('.num')).toHaveText('#1');
});
