const promiseLimit = require("promise-limit");
const puppeteer = require("puppeteer");

const waitForRender = function (options) {
    options = options || {};

    return new Promise((resolve, reject) => {
        // Render when an event fires on the document.
        if (options.renderAfterDocumentEvent) {
            if (window["__PRERENDER_STATUS"] && window["__PRERENDER_STATUS"].__DOCUMENT_EVENT_RESOLVED) resolve();
            document.addEventListener(options.renderAfterDocumentEvent, e => resolve(e.detail));

            // Render after a certain number of milliseconds.
        } else if (options.renderAfterTime) {
            setTimeout(() => resolve(), options.renderAfterTime);

            // Default: Render immediately after page content loads.
        } else {
            resolve();
        }
    });
};

class PuppeteerRenderer {
    constructor(rendererOptions) {
        this._puppeteer = null;
        this._rendererOptions = rendererOptions || {};

        if (this._rendererOptions.maxConcurrentRoutes == null) this._rendererOptions.maxConcurrentRoutes = 0;

        if (this._rendererOptions.inject && !this._rendererOptions.injectProperty) {
            this._rendererOptions.injectProperty = "__PRERENDER_INJECTED";
        }
    }

    async initialize() {
        try {
            // Workaround for Linux SUID Sandbox issues.
            if (process.platform === "linux") {
                if (!this._rendererOptions.args) this._rendererOptions.args = [];

                if (this._rendererOptions.args.indexOf("--no-sandbox") === -1) {
                    this._rendererOptions.args.push("--no-sandbox");
                    this._rendererOptions.args.push("--disable-setuid-sandbox");
                }
            }

            this._puppeteer = await puppeteer.launch(this._rendererOptions);
        } catch (e) {
            console.error(e);
            console.error("[Prerenderer - PuppeteerRenderer] Unable to start Puppeteer");
            // Re-throw the error so it can be handled further up the chain. Good idea or not?
            throw e;
        }

        return this._puppeteer;
    }

    async handleRequestInterception(page, baseURL, allowedUrls) {
        await page.setRequestInterception(true);

        page.on("request", req => {
            // Skip third party requests if needed.
            if (this._rendererOptions.skipThirdPartyRequests) {
                allowedUrls = [...allowedUrls, baseURL];

                if (!allowedUrls.reduce((isOk, start) => isOk || req.url().startsWith(start), false)) {
                    console.log("BLOQUED ", req.url());

                    req.abort();
                    return;
                }
            }

            req.continue();
        });
    }

    async renderRoutes(routes, Prerenderer) {
        const rootOptions = Prerenderer.getOptions();
        const options = this._rendererOptions;

        const limiter = promiseLimit(this._rendererOptions.maxConcurrentRoutes);

        const pagePromises = Promise.all(routes.map((route, index) => limiter(async () => {
            const page = await this._puppeteer.newPage();

            if (options.consoleHandler) {
                page.on("console", message => options.consoleHandler(route, message));
            }

            if (options.inject) {
                await page.evaluateOnNewDocument(`(function () { window['${options.injectProperty}'] = ${JSON.stringify(options.inject)}; })();`);
            }

            const baseURL = `http://localhost:${rootOptions.server.port}`;

            // Allow setting viewport widths and such.
            if (options.viewport) await page.setViewport(options.viewport);

            await this.handleRequestInterception(page, baseURL, options.allowedUrls || []);

            // Hack just in-case the document event fires before our main listener is added.
            if (options.renderAfterDocumentEvent) {
                page.evaluateOnNewDocument(function (options) {
                    window["__PRERENDER_STATUS"] = {};
                    document.addEventListener(options.renderAfterDocumentEvent, () => {
                        window["__PRERENDER_STATUS"].__DOCUMENT_EVENT_RESOLVED = true;
                    });
                }, this._rendererOptions);
            }

            let navigationOptions = {};
            if (options.navigationOptions) {
                navigationOptions = options.navigationOptions;
            }
            navigationOptions.waituntil = "networkidle0";
            navigationOptions.timeout = 0;

            console.log(`\nRoute started : ${route}`);
            const timeStart = Date.now();
            await page.goto(`${baseURL}${route}`, navigationOptions);

            // Wait for some specific element exists
            const { renderAfterElementExists } = this._rendererOptions;
            if (renderAfterElementExists && typeof renderAfterElementExists === "string") {
                await page.waitForSelector(renderAfterElementExists);
            }
            // Once this completes, it's safe to capture the page contents.
            const iframeContent = await page.evaluate(waitForRender, this._rendererOptions);
            console.log(`\nRoute done : ${route} - ${(Date.now() - timeStart) / 1000}s`);

            // const iframeContent = await page.evaluate(() => document.querySelector("iframe").contentWindow.document.querySelector("html").outerHTML);

            const result = {
                originalRoute: route,
                route: await page.evaluate("window.location.pathname"),
                html: iframeContent,
                screenShot: await page.screenshot()
            };

            await page.close();
            return result;
        })));

        return pagePromises;
    }

    destroy() {
        this._puppeteer.close();
    }
}

module.exports = PuppeteerRenderer;