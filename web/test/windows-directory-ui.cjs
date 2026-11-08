// Run with the existing Docker browser against an isolated Windows test Web.
const { chromium } = require('playwright');
const { randomUUID } = require('node:crypto');
const { writeFile } = require('node:fs/promises');
const assert = require('node:assert/strict');
(async () => {
  const [base, cwd] = process.argv.slice(2);
  assert.ok(base && /^[a-z]:\//i.test(cwd), 'Provide isolated Web URL and a dedicated Windows test directory');
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage(), report = { cwd, checks: [] };
  let project;
  try {
    await page.goto(base);
    await page.getByRole('button', { name: '创建账号', exact: true }).click();
    await page.getByLabel('账号', { exact: true }).fill('winui_' + randomUUID().slice(0, 12));
    await page.getByLabel('密码', { exact: true }).fill(randomUUID());
    await page.getByRole('button', { name: '注册并登录' }).click();
    await page.getByRole('button', { name: '新建项目', exact: true }).waitFor();
    const options = await (await context.request.get(base + '/api/project-options')).json();
    assert.equal(options.platform, 'windows', JSON.stringify(options));
    await page.getByRole('button', { name: '新建项目', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: cwd.slice(0, 2), exact: true }).click();
    for (const name of cwd.slice(3).split('/').filter(Boolean)) {
      await dialog.getByRole('group', { name: '选择项目文件夹' }).getByRole('button', { name, exact: true }).click();
    }
    await dialog.getByText(cwd.replaceAll('/', '\\'), { exact: true }).waitFor();
    await dialog.getByRole('button', { name: '上一级', exact: true }).click();
    await dialog.getByRole('group', { name: '选择项目文件夹' }).getByRole('button', { name: cwd.split('/').at(-1), exact: true }).click();
    await dialog.getByText(cwd.replaceAll('/', '\\'), { exact: true }).waitFor();
    assert.equal(await dialog.locator('input').count(), 0);
    await page.screenshot({ path: '/tmp/project-windows-dialog.png', fullPage: true });
    await dialog.getByRole('button', { name: '确定', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const response = await (await context.request.get(base + '/api/projects')).json();
    project = response.projects.find(p => p.cwd.replaceAll('\\', '/').toLowerCase() === cwd.toLowerCase());
    assert.ok(project && project.sessions.length);
    report.checks.push('从Linux浏览器识别Windows执行端、点选盘符和多级目录、返回上级、无需路径输入创建会话');
    report.passed = true;
  } catch (error) {
    report.passed = false; report.error = error.message;
    report.uiErrors = await page.locator('.inline-error').allTextContents();
    await page.screenshot({ path: '/tmp/project-windows-failure.png', fullPage: true }); throw error;
  } finally {
    if (project) for (const session of project.sessions) {
      await context.request.delete(`${base}/api/projects/${project.id}/sessions/${session.id}`);
    }
    await writeFile('/tmp/project-windows-acceptance.json', JSON.stringify(report, null, 2), 'utf8');
    await browser.close(); console.log(JSON.stringify(report));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
