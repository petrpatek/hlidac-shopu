const Apify = require("apify");
const {
  toProduct,
  uploadToS3,
  s3FileName
} = require("@hlidac-shopu/actors-common/product.js");

const {
  getSubcategoriesUrls,
  siteMapToLinks,
  fillProductData,
  tryGetRetailPrice,
  getReview,
  getProductDetailCategories,
  getPrice,
  getVariantName
} = require("./utils");

const {
  utils: { log }
} = Apify;

exports.handleSitemap = async ({ body, crawler }) => {
  const links = siteMapToLinks(body);
  for (const url of links) {
    await crawler.requestQueue.addRequest({
      url,
      userData: {
        label: "CATEGORY"
      }
    });
  }
};

exports.handleCategory = async ({ request, $, crawler }, countryPath, type) => {
  // If category contains subcategories then don't add it to requestQueue
  // subcategories were already added in request queue
  const subcategories = getSubcategoriesUrls($);
  log.info(
    `[CATEGORY]: found ${subcategories.length} subcategories --- ${request.url}`
  );
  if (subcategories.length === 0) {
    try {
      const dataCategory = JSON.parse(
        $("div[class='js-product-list']").eq(0).attr("data-category")
      );
      log.info(
        `[CATEGORY]: found ${dataCategory.totalCount} products --- ${request.url}`
      );
      if (type === "DAILY") {
        await crawler.requestQueue.addRequest({
          url:
            `https://sik.search.blue.cdtapps.com/${countryPath}/product-list-page/more-products?category=${dataCategory.id}` +
            `&sort=RELEVANCE&start=0&end=${dataCategory.totalCount}&c=lf`,
          userData: {
            label: "LIST"
          }
        });
      } else if (type === "COUNT") {
        return parseInt(dataCategory.totalCount, 10);
      }
    } catch (e) {
      log.info(
        `[CATEGORY]: Category does not contain any products --- ${request.url}`
      );
      if (type === "COUNT") {
        return 0;
      }
    }
  }
  if (type === "COUNT") {
    return 0;
  }
};

exports.handleList = async ({ request, body, crawler }) => {
  let products = [];
  try {
    products = JSON.parse(body).moreProducts.productWindow;
    log.info(
      `[LIST]: ready to scrape ${products.length} products --- ${request.url}`
    );
  } catch (e) {
    log.info(
      `[LIST]: ${JSON.parse(body).reason}, removing from scraped pages --- ${
        request.url
      }`
    );
  }
  for (const product of products) {
    const productVariants = product.gprDescription.variants;
    const productData = fillProductData(product, productVariants.length);
    // add product detail to request queue
    await crawler.requestQueue.addRequest({
      url: product.pipUrl,
      userData: {
        label: "DETAIL",
        productData
      }
    });
    // handle product variants
    for (const variant of productVariants) {
      productData.itemId = variant.id;
      productData.itemUrl = variant.pipUrl;
      productData.variantName = variant.imageAlt.substr(
        variant.imageAlt.indexOf(productData.productTypeName) +
          productData.productTypeName.length +
          2
      );
      await crawler.requestQueue.addRequest({
        url: variant.pipUrl,
        userData: {
          label: "DETAIL",
          productData
        }
      });
    }
  }
};

exports.handleDetail = async ({ $ }, productData) => {
  const { s3, country } = global;
  productData.currentPrice = getPrice($) || productData.currentPrice;
  productData.originalPrice = tryGetRetailPrice($) || null;
  if (
    productData.originalPrice &&
    productData.currentPrice < productData.originalPrice
  ) {
    productData.discounted = true;
    productData.sale = Math.round(
      ((productData.originalPrice - productData.currentPrice) /
        productData.originalPrice) *
        100
    );
  }

  if (!productData.variantName) {
    productData.variantName =
      getVariantName($, productData.productTypeName) || "";
  }
  if (productData.variantName) {
    productData.itemName += ` - ${productData.variantName}`;
  }
  delete productData.variantName;
  delete productData.productTypeName;

  productData.currency = $("div[data-currency]").eq(0).attr("data-currency");

  // productData.description = $("p[class='range-revamp-product-summary__description']").eq(0).text();
  const review = getReview($);
  productData.rating = review.reviewScore;
  productData.numberOfReviews = review.numberOfReviews;

  const categories = getProductDetailCategories($);
  const slug = await s3FileName(productData);
  productData = {
    ...productData,
    category: categories,
    slug: slug
  };

  await Apify.pushData(productData);
  await uploadToS3(
    s3,
    `ikea.${country.toLowerCase()}`,
    slug,
    "jsonld",
    toProduct(
      {
        ...productData,
        inStock: true
      },
      { priceCurrency: productData.currency }
    )
  );
};
