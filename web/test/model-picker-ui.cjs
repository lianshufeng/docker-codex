// Run from an isolated container with the image's preinstalled browser.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { chromium } = require('playwright');

const base = process.argv[2];
const fixture = process.argv[3];
const effect = async (text, path, model, effort, count = 1) => {
  const result = await (await fetch(fixture + '/captured')).json();
  const matching = result.filter(request => request.text === text);
  assert.equal(matching.length, count);
  for (const request of matching) assert.deepEqual(request, { path, model, effort, text });
};

async function run() {
  const browser = await chromium.launch();
  try {
    const id = randomUUID().slice(0, 8);
    const desktop = await browser.newContext();
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await desktop.newPage(), phone = await mobile.newPage();
    const errors = [];
    for (const target of [page, phone]) target.on('pageerror', error => errors.push(error.message));
    for (const [index, target] of [page, phone].entries()) {
      await target.goto(base);
      const data = {
        username: `models-${id}-${index}`, password: `pw-${id}-isolation`,
      };
      const response = await target.request.post(base + '/api/auth/register', { data });
      assert.equal(response.status(), 201);
      assert.equal((await target.request.post(base + '/api/auth/login', { data })).status(), 200);
      await target.reload();
      await target.waitForFunction(async () => (await (await fetch('/api/status')).json()).connected);
    }
    const route = path => base + '/api' + path;
    assert.equal((await fetch(route('/models'))).status, 401);
    const inventory = await page.request.get(route('/models'));
    assert.equal(inventory.status(), 200);
    const catalog = await inventory.json();
    assert.deepEqual(catalog.providers.slice(0, 2).map(provider => provider.id), ['fixture_a', 'fixture_b']);
    assert.doesNotMatch(JSON.stringify(catalog), /temporary-test-only|base_url|38119/);

    const created = await page.request.post(route('/projects'), { data: { name: `模型验收-${id}` } });
    assert.equal(created.status(), 201, await created.text());
    const { project } = await created.json();
    const first = project.sessions[0].id;
    const sessionPath = sid => `/projects/${project.id}/sessions/${sid}`;
    for (const target of [page, phone]) {
      await target.evaluate(async ({ projectId, sessionId }) => {
        const { user } = await (await fetch('/api/me')).json();
        localStorage.setItem('codex-selection-' + user.id, JSON.stringify({ pid: projectId, sid: sessionId }));
      }, { projectId: project.id, sessionId: first });
      await target.reload();
      const picker = target.locator('.composer select[aria-label="模型"]');
      await picker.locator('option[value="gpt-5.3-codex"]').waitFor({ state: 'attached' });
    }
    const picker = page.getByRole('combobox', { name: '模型', exact: true });
    const effort = page.getByRole('combobox', { name: '思考强度' });
    const message = page.getByRole('textbox', { name: '发送消息' });
    await picker.focus();
    await picker.press('End');
    assert.equal(await picker.inputValue(), 'gpt-5.3-codex');
    assert.equal(await effort.inputValue(), 'none');
    await effort.selectOption('high');
    assert.equal(await phone.getByRole('combobox', { name: '模型', exact: true }).inputValue(), '');
    assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth), 390);
    await message.fill(`普通-${id}`);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.getByText('隔离模型已响应', { exact: true }).first().waitFor();
    await effect(`普通-${id}`, '/a/v1/responses', 'gpt-5.3-codex', 'high');

    await picker.selectOption('gpt-5.4');
    await effort.selectOption('low');
    await page.getByRole('button', { name: '普通模式' }).click();
    await message.fill(`计划 HOLD-${id}`);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.getByRole('button', { name: '停止任务' }).waitFor();
    await phone.getByRole('button', { name: '停止任务' }).waitFor();
    assert.equal(await picker.isDisabled(), true);
    assert.equal(await effort.isDisabled(), true);
    await page.getByRole('button', { name: '停止任务' }).waitFor({ state: 'hidden' });
    await effect(`计划 HOLD-${id}`, '/a/v1/responses', 'gpt-5.4', 'low');
    const sharedHistory = await phone.request.get(route(sessionPath(first) + '/history?view=items'));
    assert.equal(sharedHistory.status(), 200);
    assert.match(await sharedHistory.text(), new RegExp(`计划 HOLD-${id}`));

    const invalid = await page.request.post(route(sessionPath(first) + '/messages'), { data: {
      text: 'INVALID', modelSettings: { model: 'gpt-5.4', effort: 'unsupported' },
    } });
    assert.equal(invalid.status(), 400);
    const replay = { requestId: id.repeat(4), text: `去重-${id}`, modelSettings: { model: 'gpt-5.4', effort: 'low' } };
    assert.equal((await page.request.post(route(sessionPath(first) + '/messages'), { data: replay })).status(), 200);
    const duplicate = await page.request.post(route(sessionPath(first) + '/messages'), { data: replay });
    assert.equal((await duplicate.json()).duplicate, true);
    const conflict = await page.request.post(route(sessionPath(first) + '/messages'), { data: {
      ...replay, modelSettings: { ...replay.modelSettings, effort: 'high' },
    } });
    assert.equal(conflict.status(), 409);
    await page.getByRole('button', { name: '停止任务' }).waitFor({ state: 'hidden' });
    await effect(replay.text, '/a/v1/responses', 'gpt-5.4', 'low');

    await page.getByRole('button', { name: '新建项目', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '新建项目' });
    await dialog.getByRole('textbox', { name: '项目名称' }).fill(project.name);
    await dialog.getByRole('combobox', { name: '模型' }).selectOption(JSON.stringify(['fixture_b', 'gpt-5.4']));
    const response = page.waitForResponse(result => result.url().endsWith('/api/projects') && result.request().method() === 'POST');
    await dialog.getByRole('button', { name: '确定' }).click();
    const opened = await response;
    assert.equal(opened.status(), 201, await opened.text());
    const second = (await opened.json()).project.sessions[0].id;
    await message.fill(`乙服务-${id}`);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.getByText('隔离模型已响应', { exact: true }).first().waitFor();
    await effect(`乙服务-${id}`, '/b/v1/responses', 'gpt-5.4', 'low');
    const directory = `/projects/${project.id}`;
    await page.locator('.composer input[type="file"]').setInputFiles({
      name: '共享.txt', mimeType: 'text/plain', buffer: Buffer.from('模型验收共享文件'),
    });
    const attachment = page.getByRole('button', { name: '移除附件 1' });
    await attachment.waitFor();
    await message.fill(`共享附件-${id}`);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await attachment.waitFor({ state: 'hidden' });
    const contents = await phone.request.get(route(directory + '/files?path=attachments'));
    assert.equal(contents.status(), 200);
    const file = (await contents.json()).files.find(entry => entry.name.endsWith('共享.txt'));
    assert.ok(file);
    const shared = await phone.request.get(route(directory + '/download?path=' + encodeURIComponent('attachments/' + file.name)));
    assert.equal(shared.status(), 200);
    assert.match(await shared.text(), /模型验收共享文件/);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ projectId: project.id, first, second, passed: true }, null, 2));
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
