const { getOrIncStatsValue } = require("../../tools.js");
const { enqueueLastPage } = require("./enqueueLastPage.js");
const {
  splitPriceRangeToTwoRequest
} = require("./splitPriceRangeToTwoRequest.js");
const { MAX_PAGE_COUNT, PRODUCT_CELL_SELECTOR } = require("../../consts.js");

const countProductsOrSplitPriceRange = async (
  $,
  url,
  requestQueue,
  userData
) => {
  if (
    !$(".pagination").length ||
    !$(".pagination__direction_type_forward[href]").length
  ) {
    await getOrIncStatsValue($(PRODUCT_CELL_SELECTOR).length, url);
    return;
  }

  const minPrice = parseInt(
    $('input.slider-filter__input[formcontrolname="min"]').attr("value"),
    10
  );
  const maxPrice = parseInt(
    $('input.slider-filter__input[formcontrolname="max"]').attr("value"),
    10
  );

  // count products from all pages except the last one (60 pr./page)
  const pagesCount = parseInt($("li.pagination__item:last-child").text(), 10);
  if (pagesCount < MAX_PAGE_COUNT || minPrice === maxPrice) {
    await enqueueLastPage($, url, requestQueue, userData);
    await getOrIncStatsValue((pagesCount - 1) * 60, url);
    return;
  }

  await splitPriceRangeToTwoRequest(
    url,
    minPrice,
    maxPrice,
    requestQueue,
    userData
  );
};

module.exports = {
  countProductsOrSplitPriceRange
};
