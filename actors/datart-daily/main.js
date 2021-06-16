const { S3Client } = require("@aws-sdk/client-s3");
const s3 = new S3Client({ region: "eu-central-1" });
const { uploadToKeboola } = require("@hlidac-shopu/actors-common/keboola.js");
const { CloudFrontClient } = require("@aws-sdk/client-cloudfront");
const {
  invalidateCDN,
  toProduct,
  uploadToS3,
  s3FileName
} = require("@hlidac-shopu/actors-common/product.js");
const rollbar = require("@hlidac-shopu/actors-common/rollbar.js");
const Apify = require("apify");

const { log } = Apify.utils;
const LABELS = {
  START: "START",
  CATEGORY: "CATEGORY",
  CATEGORY_NEXT: "CATEGORY_NEXT",
  BF: "BF"
};
const BF = "BF";
const COUNTRY = {
  CZ: "CZ",
  SK: "SK"
};
const BASE_URL = "https://www.datart.cz";
const BASE_URL_SK = "https://www.datart.sk";

let stats = {};
const processedIds = new Set();

/**
 *
 * @param {Cheerio} $
 * @param {String} rootUrl
 * @param {COUNTRY.CZ|COUNTRY.SK} country
 * @returns {Promise<[]>}
 */
async function extractItems($, rootUrl, country) {
  const itemsArray = [];
  // products
  if ($("div.category-page-item").length > 0) {
    const categoryArr = [];
    $("p#breadcrumbs > a").each(function () {
      categoryArr.push($(this).text().trim());
    });
    categoryArr.push($("p#breadcrumbs > span").text().trim());

    $("div.category-page-item").each(function () {
      const result = {};

      // data id of the item to not enqueue the items multiply
      if ($(this).attr("data-id").length > 0) {
        result.itemId = $(this).attr("data-id");
      }

      if ($(this).attr("data-name").length > 0) {
        result.itemName = $(this)
          .attr("data-name")
          .replace(/(\n|\r)/g, "");
      }

      if ($(this).find("h3 a").length > 0) {
        result.itemUrl = `${rootUrl}${$(this).find("h3 a").attr("href")}`;
      }
      if ($(this).find("a.item-thumbnail-link img").length !== 0) {
        result.img = $(this).find("a.item-thumbnail-link img").attr("src");
      }

      result.inStock =
        !$(this).find(
          "div.availability-container > span.in-stock > span.delivery-info > a.red"
        ).length > 0;

      if ($(this).find(".price .tooltip").length > 0) {
        const priceStr = $(this).find(".price .tooltip").text();
        result.currentPrice = parseFloat(
          priceStr.replace(/[^\d,]+/g, "").replace(",", ".")
        );
      } else {
        result.currentPrice = "Price not defined.";
      }

      if ($(this).find(".price del").length > 0) {
        const origPriceStr = $(this).find(".price del").text();
        result.originalPrice = parseFloat(
          origPriceStr.replace(/[^\d,]+/g, "").replace(",", ".")
        );
      }

      result.currency = country === COUNTRY.CZ ? "CZK" : "EUR";
      result.category = categoryArr;
      result.discounted = false;
      itemsArray.push(result);
    });
  }
  return itemsArray;
}

async function enqueuRequests(requestQueu, items) {
  for (const item of items) {
    await requestQueu.addRequest(item);
  }
}

Apify.main(async () => {
  rollbar.init();
  const cloudfront = new CloudFrontClient({ region: "eu-central-1" });
  const input = await Apify.getInput();
  const {
    development = false,
    debug = false,
    maxRequestRetries = 3,
    maxConcurrency = 10,
    country = COUNTRY.CZ,
    proxyGroups = ["CZECH_LUMINATI"],
    type = "FULL"
  } = input ?? {};

  stats = (await Apify.getValue("STATS")) || {
    categories: 0,
    pages: 0,
    items: 0,
    itemsSkipped: 0,
    itemsDuplicity: 0,
    failed: 0
  };

  const rootUrl = country === COUNTRY.CZ ? BASE_URL : BASE_URL_SK;
  // Get queue and enqueue first url.
  const requestQueue = await Apify.openRequestQueue();
  if (type === BF) {
    await requestQueue.addRequest({
      url: `${rootUrl}/black_friday/index.html`,
      userData: {
        label: LABELS.BF
      }
    });
  } else if (type === "FULL") {
    await requestQueue.addRequest({
      url: `${rootUrl}/katalog/index.html`,
      userData: {
        label: LABELS.START
      }
    });
  } else if (type === "TEST") {
    await requestQueue.addRequest({
      url: `https://www.datart.${country.toLowerCase()}/kvadrokoptery-drony-a-rc-modely.html?startPos=16`,
      userData: {
        label: "CATEGORY_NEXT"
      }
    });
  }

  const persistState = async () => {
    await Apify.setValue("STATS", stats).then(() => log.debug("STATS saved!"));
    log.info(JSON.stringify(stats));
  };
  Apify.events.on("persistState", persistState);

  log.info("ACTOR - setUp crawler");
  /** @type {ProxyConfiguration} */
  const proxyConfiguration = await Apify.createProxyConfiguration({
    groups: proxyGroups,
    useApifyProxy: !development
  });

  const crawler = new Apify.CheerioCrawler({
    requestQueue,
    proxyConfiguration,
    maxRequestRetries,
    maxConcurrency,
    // Activates the Session pool.
    useSessionPool: true,
    // Overrides default Session pool configuration.
    sessionPoolOptions: {
      maxPoolSize: 200
    },
    handlePageFunction: async ({ request, $, session, response }) => {
      if (response.statusCode !== 200) {
        session.retire();
      }

      // Process START page
      if (request.userData.label === LABELS.START) {
        const items = [];
        $("div#content")
          .find("a.list")
          .each(function () {
            const link = $(this).attr("href");
            items.push({
              url: `${rootUrl}${link}`,
              userData: {
                label: LABELS.CATEGORY,
                uniqueKey: Math.random()
              }
            });
          });
        console.log(`${request.url} Found ${items.length} categories`);
        await enqueuRequests(requestQueue, items);
      }

      // Process CATEGORY page
      if (request.userData.label === LABELS.CATEGORY) {
        try {
          // Add subcategories if this category has no listings
          if ($("div.subcategory-tree-list").length > 0) {
            const items = [];
            $("div.subcategory-tree-list")
              .find("a")
              .each(function () {
                const link = $(this).attr("href");
                items.push({
                  url: `${rootUrl}${link}`,
                  userData: {
                    label: LABELS.CATEGORY,
                    uniqueKey: Math.random()
                  }
                });
              });
            stats.categories += items.length;
            console.log(`${request.url} Found ${items.length} subcategories`);
            await enqueuRequests(requestQueue, items);
            return; // Nothing more we can do for this page
          }
          // Add pages from pagination
          const itemsInCategory = parseInt(
            $("#total-products-category").text()
          );
          const items = [];
          for (let i = 16; i < itemsInCategory; i += 16) {
            items.push({
              url: `${request.url}?startPos=${i}`,
              userData: {
                label: LABELS.CATEGORY_NEXT,
                uniqueKey: Math.random()
              }
            });
          }
          stats.pages += items.length;
          console.log(`${request.url} Adding ${items.length} pagination pages`);
          await enqueuRequests(requestQueue, items);
        } catch (e) {
          console.log(`Error processing url ${request.url}`);
          console.error(e);
        }
      }

      // Extract products from category page
      if (
        request.userData.label === LABELS.CATEGORY ||
        request.userData.label === LABELS.CATEGORY_NEXT
      ) {
        try {
          const products = await extractItems($, rootUrl, country);
          // we don't need to block pushes, we will await them all at the end
          const requests = [];
          for (const product of products) {
            const s3item = { ...product };
            //Keboola data structure fix
            delete product.inStock;
            // Save data to dataset
            if (!processedIds.has(product.itemId)) {
              processedIds.add(product.itemId);
              requests.push(
                Apify.pushData(product),
                uploadToS3(
                  s3,
                  `datart.${country.toLowerCase()}`,
                  await s3FileName(s3item),
                  "jsonld",
                  toProduct(s3item, {})
                )
              );
              stats.items++;
            } else {
              stats.itemsDuplicity++;
            }
          }
          console.log(
            `${request.url} Found ${requests.length / 2} unique products`
          );
          // await all requests, so we don't end before they end
          await Promise.allSettled(requests);
        } catch (e) {
          console.log(`Failed to get products from page ${request.url}`);
          await Apify.pushData({
            status: "Failed to get products",
            url: request.url
          });
        }
      }

      if (request.userData.label === LABELS.BF) {
        log.info(`START BF ${request.url}`);
        const categories = [];
        $(".category-box").each(function () {
          categories.push({
            url: `${rootUrl}${$(this).attr("href")}`,
            userData: {
              label: LABELS.CATEGORY
            }
          });
        });
        log.info(`Found ${categories.length} BF categories`);
        await enqueuRequests(requestQueue, categories);
      }
    },

    // If request failed 4 times then this function is executed.
    handleFailedRequestFunction: async ({ request }) => {
      console.log(`Request ${request.url} failed multiple times`);
    }
  });

  // Run crawler.
  await crawler.run();

  console.log("crawler finished");

  await Apify.setValue("STATS", stats).then(() => log.debug("STATS saved!"));
  log.info(JSON.stringify(stats));

  try {
    const env = await Apify.getEnv();

    let tableName = "";

    if (type === "FULL" && country === "CZ") {
      tableName = "datart";
    } else if (type === "FULL" && country === "SK") {
      tableName = "datart_sk";
    } else if (type !== "FULL" && country === "CZ") {
      tableName = "datart_bf";
    } else if (type !== "FULL" && country === "SK") {
      tableName = "datart_sk_bf";
    }

    if (!development) {
      await invalidateCDN(
        cloudfront,
        "EQYSHWUECAQC9",
        `datart.${country.toLowerCase()}`
      );
      log.info("invalidated Data CDN");
      await uploadToKeboola(tableName);
      log.info("upload to Keboola finished");
    }
  } catch (e) {
    console.log(e);
  }

  console.log("Finished.");
});
