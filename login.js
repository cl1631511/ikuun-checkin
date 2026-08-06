const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

chromium.use(stealth());

// ---- 尝试登录函数 ----
async function tryLogin(domain, email, password, browser) {
    const page = await browser.newPage();
    
    try {
        console.log(`🌐 尝试访问: ${domain}`);
        await page.goto(`${domain}/auth/login`, { waitUntil: 'networkidle', timeout: 30000 });
        console.log(`✅ 成功连接: ${domain}`);
        console.log('Page title:', await page.title());

        console.log('Filling credentials...');
        await page.fill('#email', email);
        await page.fill('#password', password);

        console.log('Waiting for GeeTest captcha to load...');
        await page.waitForFunction(() => window.Captcha && window.Captcha.isLoaded(), { timeout: 30000 });

        await page.waitForFunction(
            () => document.querySelector('.geetest_btn_click') !== null,
            { timeout: 30000 }
        );
        console.log('GeeTest captcha loaded and ready');

        console.log('Clicking GeeTest verify button...');
        const btn = page.locator('.geetest_btn_click');
        const box = await btn.boundingBox();
        if (!box) {
            console.error('GeeTest button not found');
            await page.screenshot({ path: 'debug-no-btn.png', fullPage: true });
            await page.close();
            return { success: false, page: null, error: 'GeeTest button not found' };
        }
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
        await page.waitForTimeout(200);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: 100 });

        console.log('Waiting for captcha verification...');
        let passed = false;
        for (let i = 0; i < 60; i++) {
            await page.waitForTimeout(1000);
            const state = await page.evaluate(() => ({
                isReady: window.Captcha?.isReady(),
                error: window.Captcha?.getError(),
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
            await page.close();
            return { success: false, page: null, error: 'Captcha verification failed' };
        }

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

        try {
            await page.waitForURL('**/user', { timeout: 15000 });
            console.log('✅ 登录成功！');
            return { success: true, page, domain };
        } catch (e) {
            console.error('登录失败，当前URL:', page.url());
            if (loginResult) console.error('登录响应:', JSON.stringify(loginResult));
            await page.close();
            return { success: false, page: null, error: loginResult?.message || 'Login timeout' };
        }
    } catch (e) {
        console.error(`❌ 访问 ${domain} 失败: ${e.message}`);
        await page.close();
        return { success: false, page: null, error: e.message };
    }
}

// ---- 主函数 ----
(async () => {
    const email = process.env.EMAIL;
    const password = process.env.PASSWORD;
    const mainDomain = process.env.DOMAIN || 'https://ikuuu.fyi';
    const backupDomainsStr = process.env.BACKUP_DOMAINS || '';

    // 解析备用域名
    const backupList = backupDomainsStr
        .split(/[\s,，\n]+/)
        .map(d => d.trim())
        .filter(d => d.length > 0);

    // 构建完整域名列表：主域名 + 备用域名
    const domains = [mainDomain, ...backupList];

    if (!email || !password) {
        console.error('EMAIL and PASSWORD environment variables are required');
        process.exit(1);
    }

    console.log(`📋 主域名: ${mainDomain}`);
    console.log(`📋 备用域名: ${backupList.length} 个`);

    const browser = await chromium.launch({
        headless: false,
        args: ['--disable-blink-features=AutomationControlled'],
    });

    let successPage = null;
    let successDomain = null;

    for (let i = 0; i < domains.length; i++) {
        const domain = domains[i];
        console.log(`\n--- [${i+1}/${domains.length}] 尝试 ${domain} ---`);
        
        const result = await tryLogin(domain, email, password, browser);
        
        // 只有登录成功才算成功
        if (result.success) {
            successDomain = result.domain;
            successPage = result.page;
            console.log(`🎉 成功登录: ${successDomain}`);
            break;
        }
        
        if (i < domains.length - 1) {
            console.log(`⏳ 等待 3 秒后尝试下一个域名...`);
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    }

    if (!successPage || !successDomain) {
        console.error('❌ 所有域名登录均失败');
        await browser.close();
        process.exit(1);
    }

    // Save cookies
    const cookies = await successPage.context().cookies();
    let cookieFile = '# Netscape HTTP Cookie File\n';
    for (const c of cookies) {
        const d = c.domain.startsWith('.') ? c.domain : '.' + c.domain;
        const expires = c.expires > 0 ? Math.floor(c.expires) : 0;
        cookieFile += `${d}\tTRUE\t${c.path}\t${c.secure ? 'TRUE' : 'FALSE'}\t${expires}\t${c.name}\t${c.value}\n`;
    }
    fs.writeFileSync('cookie.txt', cookieFile);
    console.log('Cookies saved to cookie.txt');

    await browser.close();
    console.log('✅ 登录流程完成');
})();
