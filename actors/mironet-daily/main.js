const { S3Client } = require("@aws-sdk/client-s3");
const s3 = new S3Client({ region: "eu-central-1" });
const { CloudFrontClient } = require("@aws-sdk/client-cloudfront");
const { uploadToKeboola } = require("@hlidac-shopu/actors-common/keboola.js");
const {
  toProduct,
  uploadToS3,
  shopName,
  s3FileName,
  invalidateCDN
} = require("@hlidac-shopu/actors-common/product.js");
const rollbar = require("@hlidac-shopu/actors-common/rollbar.js");
const Apify = require("apify");
const cheerio = require("cheerio");
const zlib = require("zlib");

const { log, requestAsBrowser } = Apify.utils;
const BF = "BF";
let stats = {};
const processedIds = new Set();

/**
 * Gets attribute as text from a ElementHandle.
 * @param {ElementHandle} element - The element to get attribute from.
 * @param {string} attr - Name of the attribute to get.
 */
const WEB = "https://www.mironet.cz";
const SITEMAP_URL = "https://www.mironet.cz/sm/sitemap_kategorie_p_1.xml.gz";

async function enqueueRequests(requestQueue, items) {
  log.info(
    `Waiting for ${items.length} categories add to request queue. It will takes some time.`
  );
  for (const item of items) {
    await requestQueue.addRequest(item);
  }
}

async function streamToBuffer(stream) {
  const chunks = [];
  return new Promise((resolve, reject) => {
    stream.on("data", chunk => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function enqueueAllCategories(requestQueue) {
  const stream = await requestAsBrowser({ url: SITEMAP_URL, stream: true });
  const buffer = await streamToBuffer(stream);
  const xmlString = zlib.unzipSync(buffer).toString();
  const $ = cheerio.load(xmlString, { xmlMode: true });
  const categoryUrls = [];

  // Pick all urls from sitemap
  $("url").each(function () {
    const url = $(this).find("loc").text().trim();
    categoryUrls.push({
      url,
      userData: {
        label: "page",
        baseUrl: url
      }
    });
  });
  await enqueueRequests(requestQueue, categoryUrls);
  log.info(`Enqueued ${categoryUrls.length} categories`);
}

/** Main function */
Apify.main(async () => {
  rollbar.init();
  const cloudfront = new CloudFrontClient({ region: "eu-central-1" });
  const input = await Apify.getInput();
  stats = (await Apify.getValue("STATS")) || {
    urls: 0,
    pages: 0,
    items: 0,
    itemsDuplicity: 0,
    failed: 0
  };
  const {
    development = false,
    debug = false,
    maxRequestRetries = 3,
    maxConcurrency = 10,
    country = "cz",
    proxyGroups = ["CZECH_LUMINATI"],
    type = "FULL"
  } = input ?? {};
  const shop = await shopName(WEB);

  if (development || debug) {
    Apify.utils.log.setLevel(Apify.utils.log.LEVELS.DEBUG);
  }
  // Open request queue and add statrUrl
  const requestQueue = await Apify.openRequestQueue();
  if (type === BF) {
    await requestQueue.addRequest({
      url: "https://www.mironet.cz/vyprodej/?v=black-friday",
      userData: {
        label: "category_vyprodej"
      }
    });
  } else {
    await enqueueAllCategories(requestQueue);

    // for testing of single page
    /*await requestQueue.addRequest({
      url: "https://www.mironet.cz/graficke-karty+c14402/",
      userData: {
        label: "page",
        baseUrl: "https://www.mironet.cz/graficke-karty+c14402/"
      }
    });*/
  }

  log.info("ACTOR - setUp crawler");
  /** @type {ProxyConfiguration} */
  const proxyConfiguration = await Apify.createProxyConfiguration({
    groups: proxyGroups,
    useApifyProxy: !development
  });

  const persistState = async () => {
    await Apify.setValue("STATS", stats).then(() => log.debug("STATS saved!"));
    log.info(JSON.stringify(stats));
  };
  Apify.events.on("persistState", persistState);

  // Create crawler
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
    // Handle page context
    handlePageFunction: async ({ $, request, session, response }) => {
      if (response.statusCode !== 200 && response.statusCode !== 404) {
        log.info(`${request.url} -> Bad response code: ${response.statusCode}`);
        session.retire();
      }

      if (request.userData.label === "category_vyprodej") {
        const categories = [];
        let onclickUrl;
        $(".vyprodej_category_head").each(function () {
          const moreBox = $(this).find(".bpMoreBox");
          if (moreBox.length !== 0) {
            moreBox.find("a").each(function () {
              categories.push({
                url: `${WEB}${$(this).attr("href")}`,
                userData: {
                  label: "category"
                }
              });
            });
          } else {
            const onClick = $(this).attr("onclick");
            onclickUrl = onClick
              .replace("location.href=", "")
              .replace(/'/g, "");
          }
        });
        if (categories.length !== 0) {
          await enqueueRequests(requestQueue, categories);
        } else if (onclickUrl) {
          await requestQueue.addRequest({
            url: `${WEB}${onclickUrl}`,
            userData: {
              label: "category"
            }
          });
        }
      } else if (request.userData.label === "category") {
        const pages = [];
        const browseSubCategories = $("div#BrowseSubCategories > a");
        if (browseSubCategories.length > 0) {
          browseSubCategories.each(function () {
            pages.push({
              url: `${WEB}${$(this).attr("href")}`,
              userData: {
                label: "page",
                baseUrl: `${WEB}${$(this).attr("href")}`
              }
            });
          });
          stats.urls += pages.length;
          log.info(`Found ${pages.length} valid urls by ${request.url}`);
          await enqueueRequests(requestQueue, pages, false);
        } else {
          log.info(`Enqueue ${request.url} as a page`);
          await requestQueue.addRequest(
            new Apify.Request({
              url: request.url,
              userData: {
                label: "page",
                baseUrl: `${WEB}${$(this).attr("href")}`
              }
            })
          );
        }
      }
      // This is the category page
      else if (
        request.userData.label === "page" ||
        request.userData.label === "pages"
      ) {
        try {
          if (request.userData.label === "page") {
            let pageNum = 0;
            $("a.PageNew").each(function () {
              pageNum =
                pageNum < parseInt($(this).text().trim())
                  ? parseInt($(this).text().trim())
                  : pageNum;
              // pageItems.push(`${request.userData.baseUrl}${$(this).attr('href')}`);
            });
            if (pageNum > 0) {
              stats.pages += pageNum;
              log.info(`Found ${pageNum} pages on ${request.url}`);
              const { baseUrl } = request.userData;
              const url = baseUrl.includes("?")
                ? `${baseUrl}&PgID=`
                : `${baseUrl}?PgID=`;
              for (let i = 2; i <= pageNum; i++) {
                await requestQueue.addRequest(
                  new Apify.Request({
                    userData: {
                      label: "pages",
                      baseUrl: request.userData.baseUrl
                    },
                    url: `${url}${i}`
                  })
                );
              }
            }
          }
          const breadCrumbs = [];
          $("div#displaypath > a.CatParent").each(function () {
            breadCrumbs.push($(this).text().trim());
          });
          // we don't need to block pushes, we will await them all at the end
          const requests = [];
          const rawItems = $(".item_b").toArray();
          for (const item of rawItems) {
            const toNumber = p =>
              parseInt(p.replace(/\s/g, "").match(/\d+/)[0]);

            const idElem = $(item).find(".item_kod");
            const linkElem = $(item).find(".nazev a");
            const priceElem = $(item).find(".item_cena");
            const imgElem = $(item).find(".item_obr img");
            const oPriceElem = $(item).find(".item_s_cena span");
            const img =
              imgElem.length !== 0 ? `https:${imgElem.attr("src")}` : null;
            const link = linkElem.length !== 0 ? linkElem.attr("href") : null;
            const id =
              idElem.length !== 0
                ? idElem.text().trim().replace("Kód: ", "")
                : null;
            const name = linkElem.length !== 0 ? linkElem.text().trim() : null;
            const price =
              priceElem.length !== 0 ? priceElem.text().trim() : false;
            const dataItem = {
              img,
              itemId: id,
              itemUrl: `${WEB}${link}`,
              itemName: name,
              discounted: !!oPriceElem,
              currentPrice: price ? toNumber(price) : null,
              breadCrumbs
            };
            if (oPriceElem.length !== 0) {
              const oPrice = oPriceElem.text().trim();
              dataItem.originalPrice = toNumber(oPrice);
            }
            // Save data to dataset
            if (!processedIds.has(dataItem.itemId)) {
              processedIds.add(dataItem.itemId);
              const slug = await s3FileName(dataItem);
              requests.push(
                Apify.pushData({
                  ...dataItem,
                  shop,
                  slug
                }),
                uploadToS3(
                  s3,
                  "mironet.cz",
                  await s3FileName(dataItem),
                  "jsonld",
                  toProduct(
                    {
                      ...dataItem,
                      category: dataItem.breadCrumbs.join(" > "),
                      inStock: true
                    },
                    { priceCurrency: "CZK" }
                  )
                )
              );
            } else {
              stats.itemsDuplicity++;
            }
          }
          stats.items += requests.length;
          log.info(
            `Found ${requests.length} items, storing them. ${request.url}`
          );
          // await all requests, so we don't end before they end
          await Promise.all(requests);
        } catch (e) {
          stats.failed++;
          log.error(e);
          console.log(`Failed extraction of items. ${request.url}`);
          console.error(e);
        }
      }
    },
    // If request failed 4 times then this function is executed
    handleFailedRequestFunction: async ({ request }) => {
      log.error(`Request ${request.url} failed 4 times`);
    }
  });

  log.info("ACTOR - run crawler");
  // Run crawler
  await crawler.run();
  log.info("ACTOR - crawler end");
  await Apify.setValue("STATS", stats).then(() => log.debug("STATS saved!"));
  log.info(JSON.stringify(stats));
  if (!development) {
    await invalidateCDN(cloudfront, "EQYSHWUECAQC9", "mironet.cz");
    log.info("invalidated Data CDN");
    await uploadToKeboola(type !== "FULL" ? "mironet_bf" : "mironet");
    log.info("upload to Keboola finished");
  }
  log.info("ACTOR - Finished");
});
