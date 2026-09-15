import { expect, test } from '@playwright/test';

// 场景：同一 client_op_id 携带不同内容再次提交，服务器必须返回 409，
// 页面给出明确的冲突反馈，且该操作不会进入待重试。
test('同一操作标识换内容提交返回 409 并展示冲突反馈', async ({ page }) => {
  await page.goto('/');

  await page.getByTestId('scene-input').fill('E2E-CONFLICT');
  await page.getByTestId('notes-input').fill('原始备注');
  await page.getByTestId('submit-button').click();
  await expect(page.getByTestId('shot-number-value')).toHaveText('#1');

  // 保持操作标识不变，只改动备注内容
  await page.getByTestId('notes-input').fill('被改动的内容');
  await page.getByTestId('submit-button').click();

  // 冲突反馈：说明原因，并指出该标识已占用的镜号
  const failedCard = page.getByTestId('failed-card').first();
  await expect(failedCard).toBeVisible();
  await expect(failedCard).toContainText('冲突');
  await expect(failedCard).toContainText('#1');

  // 冲突不是可重试错误：没有待重试操作
  await expect(page.getByTestId('pending-card')).toHaveCount(0);

  // 冲突不消耗号码：换新标识再提交，号码连续为 #2
  await page.getByTestId('regenerate-op-id').click();
  await page.getByTestId('notes-input').fill('下一条正常镜头');
  await page.getByTestId('submit-button').click();
  await expect(page.getByTestId('shot-number-value')).toHaveText('#2');
});
