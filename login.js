const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const https = require('https');
const url = require('url');

chromium.use(stealth());

// ---- Bark 推送函数 ----
async function sendBarkNotification(title, body, isCritical = false) {
    const barkKey = process.env.BARK_KEY;
    if (!barkKey) {
        console.log('⏭️ 未设置 BARK_KEY，跳过 Bark 推送');
        return;
    }

    const baseUrl = `https://api.day.app/${barkKey}`;
    const params = new url.URLSearchParams();
    params.append('title', title);
    params.append('body', body);
    params.append('sound', 'minimal');
    params.append('group', 'ikuun-checkin');

    // 如果是紧急提醒，添加 critical 级别和静音
    if (isCritical) {
        params.append('level', 'critical');
        params.append('volume', '0');
        console.log('🔔 签到失败，发送紧急提醒 (critical, 静音)');
    }

    const fullUrl = `${baseUrl}?${params.toString()}`;

    return new Promise((resolve) => {
        const req = https.get(fullUrl, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    console.log(`✅ Bark 推送成功${isCritical ? ' (紧急)' : ''}`);
                } else {
                    console.log(`⚠️ Bark 推送响应异常: ${res.statusCode}, ${data}`);
                }
                resolve();
            });
        });
        req.on('error', (e) => {
            console.error(`❌ Bark 推送请求失败: ${e.message}`);
            resolve();
        });
        req.setTimeout(5000, () => {
            req.destroy();
            console.error('❌ Bark 推送超时');
            resolve();
        });
        req.end();
    });
}

// ---- 签到结果检查与推送 ----
async function checkSignInResultAndNotify(domain, cookieFile) {
    try {
        // 用 cookie.txt 发送签到请求
        const cookies = fs.readFileSync(cookieFile, 'utf8');
        const response = await fetch(`${domain}/user/checkin`, {
            method: 'POST',
            headers: {
                'Cookie': cookies.trim().replace(/\n/g, '; '),
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        const result = await response.json();

        // 判断签到是否成功
        const isSuccess = result.success === true || result.status === 'success' || result.code === 200;

        if (isSuccess) {
            console.log(`✅ 签到成功: ${JSON.stringify(result)}`);
            // 签到成功，普通推送（可选）
            const msg = result.message || result.msg || '签到成功';
            await sendBarkNotification('✅ 爱哭签签到成功', `${msg}\n时间: ${new Date().toLocaleString()}`, false);
        } else {
            const errMsg = result.message || result.msg || '未知错误';
            console.error(`❌ 签到失败: ${errMsg}`);
            // 签到失败，发送紧急提醒！
            await sendBarkNotification(
                '❌ 爱哭签签到失败',
                `时间: ${new Date().toLocaleString()}\n原因: ${errMsg}\n请及时更新 Cookie！`,
                true  // 关键：传入 true 触发紧急模式
            );
        }
        return result;
    } catch (e) {
        console.error(`❌ 签到请求异常: ${e.message}`);
        // 请求异常也发送紧急提醒
        await sendBarkNotification(
            '❌ 爱哭签签到异常',
            `时间: ${new Date().toLocaleString()}\n错误: ${e.message}\n请检查网络或 Cookie！`,
            true
        );
        return null;
    }
}

// ---- 主函数 ----
(async () => {
    const email = process.env.EMAIL;
    const password = process.env.PASSWORD;
    const domain = process.env.DOMAIN || 'https://ikuuu.fyi';

    if (!email || !password) {
        console.error('EMAIL and PASSWORD environment variables are required');
        process.exit(1);
    }

    const browser = await chromium.launch({
        headless: false,
        args: ['--disable-blink-features=AutomationControlled'],
    });
    const page = await browser.newPage();

    console.log('Navigating to login page...');
    await page.goto(`${domain}/auth/login`, { waitUntil: 'networkidle', timeout: 60000 });
    console.log('Page title:', await page.title());

    console.log('Filling credentials...');
    await page.fill('#email', email);
    await page.fill('#password', password);

    // Wait for GeeTest captcha to be fully ready
    console.log('Waiting for GeeTest captcha to load...');
    await page.waitForFunction(() => window.Captcha && window.Captcha.isLoaded(), { timeout: 30000 });

    // Wait for GeeTest onReady callback (captcha UI rendered)
    await page.waitForFunction(
        () => document.querySelector('.geetest_btn_click') !== null,
        { timeout: 30000 }
    );
    console.log('GeeTest captcha loaded and ready');

    // Click GeeTest verify button using real mouse events
    console.log('Clicking GeeTest verify button...');
    const btn = page.locator('.geetest_btn_click');
    const box = await btn.boundingBox();
    if (!box) {
        console.error('GeeTest button not found');
        await page.screenshot({ path: 'debug-no-btn.png', fullPage: true });
        await browser.close();
        process.exit(1);
    }
    // Move mouse naturally then click
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
    await page.waitForTimeout(200);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: 100 });

    // Wait for captcha verification to complete
    console.log('Waiting for captcha verification...');
    let passed = false;
    for (let i = 0; i < 60; i++) {
        await page.waitForTimeout(1000);
        const state = await page.evaluate(() => ({
            isReady: window.Captcha?.isReady(),
            error: window.Captcha?.getError(),
            tipText: document.querySelector('.geetest_tip')?.textContent,
        }));

        if (state.isReady) {
            passed = true;
            console.log('Captcha verification passed!');
            break;
        }

        if (state.error) {
            console.error('Captcha error:', state.error);
            break;
        }
    }

    if (!passed) {
        console.error('Captcha verification did not pass');
        await browser.close();
        // 验证码失败也推送紧急提醒
        await sendBarkNotification(
            ' 爱哭签登录失败',
            `时间: ${new Date().toLocaleString()}\n原因: 极验验证码未通过\n请手动登录检查！`,
            true
        );
        process.exit(1);
    }

    // Capture login response before clicking (page may navigate away on success)
    let loginResult = null;
    page.on('response', async (resp) => {
        if (resp.url().includes('/auth/login') && resp.request().method() === 'POST') {
            try {
                loginResult = await resp.json();
            } catch (e) {}
        }
    });

    console.log('Clicking login button...');
    await page.click('button.login');

    // Wait for navigation to /user (success) or timeout
    try {
        await page.waitForURL('**/user', { timeout: 15000 });
        console.log('Login successful, redirected to:', page.url());
    } catch (e) {
        console.error('Login failed, current URL:', page.url());
        if (loginResult) console.error('Login response:', JSON.stringify(loginResult));
        await browser.close();
        // 登录失败推送紧急提醒
        await sendBarkNotification(
            ' 爱哭签登录失败',
            `时间: ${new Date().toLocaleString()}\n原因: ${loginResult?.message || '登录超时或密码错误'}\n请检查账号密码！`,
            true
        );
        process.exit(1);
    }

    // Save cookies in Netscape format for curl
    const cookies = await page.context().cookies();
    let cookieFile = '# Netscape HTTP Cookie File\n';
    for (const c of cookies) {
        const d = c.domain.startsWith('.') ? c.domain : '.' + c.domain;
        const expires = c.expires > 0 ? Math.floor(c.expires) : 0;
        cookieFile += `${d}\tTRUE\t${c.path}\t${c.secure ? 'TRUE' : 'FALSE'}\t${expires}\t${c.name}\t${c.value}\n`;
    }
    fs.writeFileSync('cookie.txt', cookieFile);
    console.log('Cookies saved to cookie.txt');

    await browser.close();

    // ---- 新增：签到并检查结果，推送 Bark ----
    console.log('\n----- 开始执行签到并检查结果 -----');
    await checkSignInResultAndNotify(domain, 'cookie.txt');

    console.log('\n 完整流程执行完毕');
})();
