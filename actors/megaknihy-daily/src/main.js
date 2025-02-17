const Apify = require("apify");
const { CloudFrontClient } = require("@aws-sdk/client-cloudfront");
const { uploadToKeboola } = require("@hlidac-shopu/actors-common/keboola.js");
const { invalidateCDN } = require("@hlidac-shopu/actors-common/product.js");
const rollbar = require("@hlidac-shopu/actors-common/rollbar.js");
const cheerio = require("cheerio");
const UserAgent = require("user-agents");
const { handleStart, handlePage } = require("./routes");
const { S3Client } = require("@aws-sdk/client-s3");

const {
  utils: { log }
} = Apify;

Apify.main(async () => {
  rollbar.init();
  const source = {
    url: "https://www.megaknihy.cz/",
    userData: {
      label: "START"
    }
  };
  const requestQueue = await Apify.openRequestQueue();
  await requestQueue.addRequest(source);

  global.s3 = new S3Client({ region: "eu-central-1" });
  const cloudfront = new CloudFrontClient({ region: "eu-central-1" });
  let count = 0;
  const ALREADY_SCRAPED = (await Apify.getValue("ALREADY-SCRAPED")) || [];
  const alreadyScrapedProducts = new Set(ALREADY_SCRAPED);
  // Set state persistence
  const persistState = async () => {
    await Apify.setValue("ALREADY-SCRAPED", [...alreadyScrapedProducts]);
    log.info(
      `[PERSIST]: -- Product cache has ${alreadyScrapedProducts.length} unique products.`
    );
  };

  Apify.events.on("persistState", persistState);

  const proxyConfiguration = await Apify.createProxyConfiguration({
    groups: ["CZECH_LUMINATI"]
  });

  const crawler = new Apify.PuppeteerCrawler({
    requestQueue,
    proxyConfiguration,
    maxRequestRetries: 10,
    launchContext: {
      useChrome: true,
      stealth: true,
      // Rotate user agents
      userAgent: new UserAgent([
        /Chrome/,
        { deviceCategory: "desktop" }
      ]).toString(),
      launchOptions: {
        headless: true
      }
    },
    useSessionPool: true,
    browserPoolOptions: {
      retireBrowserAfterPageCount: 30
    },
    maxConcurrency: 1,
    handlePageTimeoutSecs: 180,
    handlePageFunction: async context => {
      ++count;
      const {
        userData: { label, categories },
        url
      } = context.request;
      // Set up cheerio properties
      const body = await context.page.evaluate(
        () => document.documentElement.innerHTML
      );
      const $ = cheerio.load(body);
      const args = { url, $, body };

      // we are getting blocked by google re-captcha, so the session got useless
      const captchaButton = $(".g-recaptcha.survey-submit");
      if (captchaButton.length !== 0) {
        log.info(
          `[PAGE-BLOCKED]: Page ${url} was blocked, we need to retry with different session.`
        );
        context.session.retire();
        throw new Error(`${url} was blocked by google re-captcha.`);
      }

      switch (label) {
        case "START":
          return handleStart(args, requestQueue);
        case "PAGE":
          return handlePage(
            args,
            categories,
            requestQueue,
            context.page,
            alreadyScrapedProducts
          );
        default:
          throw new Error(`No route for label: ${label}`);
      }
    }
  });

  log.info("Starting the crawl.");
  await crawler.run();
  log.info("Crawl finished.");
  await persistState();

  await invalidateCDN(cloudfront, "EQYSHWUECAQC9", `megaknihy.cz`);
  log.info("invalidated Data CDN");

  await uploadToKeboola("megaknihy_cz");
  log.info("Finished.");
});
