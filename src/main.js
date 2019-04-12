const Apify = require('apify');
const url = require('url');
const {
    REQUIRED_PROXY_GROUP, GOOGLE_DEFAULT_RESULTS_PER_PAGE, DEFAULT_GOOGLE_SEARCH_DOMAIN_COUNTRY_CODE,
    GOOGLE_SEARCH_DOMAIN_TO_COUNTRY_CODE, GOOGLE_SEARCH_URL_REGEX } = require('./consts');
const extractorsDesktop = require('./extractors_desktop');
const extractorsMobile = require('./extractors_mobile');
const {
    getInitialRequests, executeCustomDataFunction, getInfoStringFromResults, createSerpRequest,
    logAsciiArt, createDebugInfo, ensureAccessToSerpProxy,
} = require('./tools');

const { log } = Apify.utils;

Apify.main(async () => {
    const input = await Apify.getInput();

    const { maxConcurrency, maxPagesPerQuery, customDataFunction, mobileResults, saveHtml } = input;

    // Check that user have access to SERP proxy.
    await ensureAccessToSerpProxy();
    logAsciiArt();

    // Create initial request list and queue.
    const initialRequests = getInitialRequests(input);
    if (!initialRequests.length) throw new Error('The input must contain at least one search query or URL.');
    const requestList = await Apify.openRequestList('initial-requests', initialRequests);
    const requestQueue = await Apify.openRequestQueue();
    const dataset = await Apify.openDataset();
    const extractors = mobileResults ? extractorsMobile : extractorsDesktop;

    // Create crawler.
    const crawler = new Apify.CheerioCrawler({
        requestList,
        requestQueue,
        maxConcurrency,
        requestFunction: ({ request, autoscaledPool }) => {
            const parsedUrl = url.parse(request.url, true);
            request.userData.startedAt = new Date();
            log.info(`Querying "${parsedUrl.query.q}" page number ${request.userData.page} ...`);
            return crawler._defaultRequestFunction({ request, autoscaledPool }); // eslint-disable-line
        },
        useApifyProxy: true,
        apifyProxyGroups: [REQUIRED_PROXY_GROUP],
        handlePageTimeoutSecs: 60,
        requestTimeoutSecs: 180,
        handlePageFunction: async ({ request, response, html, $ }) => {
            request.userData.finishedAt = new Date();

            const nonzeroPage = request.userData.page + 1; // Display same page numbers as Google, i.e. 1, 2, 3..
            const parsedUrl = url.parse(request.url, true);

            // We know the URL matches (otherwise we have a bug here)
            const matches = GOOGLE_SEARCH_URL_REGEX.exec(request.url);
            const domain = matches[3].toLowerCase();

            // Compose the dataset item.
            const data = {
                '#debug': createDebugInfo(request, response),
                '#error': false,
                searchQuery: {
                    term: parsedUrl.query.q,
                    device: mobileResults ? 'MOBILE' : 'DESKTOP',
                    page: nonzeroPage,
                    type: 'SEARCH',
                    domain,
                    countryCode: GOOGLE_SEARCH_DOMAIN_TO_COUNTRY_CODE[domain] || DEFAULT_GOOGLE_SEARCH_DOMAIN_COUNTRY_CODE,
                    languageCode: parsedUrl.query.hl || null,
                    locationUule: parsedUrl.query.uule || null,
                    resultsPerPage: parsedUrl.query.num || GOOGLE_DEFAULT_RESULTS_PER_PAGE,
                },
                url: request.url,
                hasNextPage: false,
                resultsTotal: extractors.extractTotalResults($),
                relatedQueries: extractors.extractRelatedQueries($, parsedUrl.host),
                paidResults: extractors.extractPaidResults($),
                paidProducts: extractors.extractPaidProducts($),
                organicResults: extractors.extractOgranicResults($),
                customData: customDataFunction
                    ? await executeCustomDataFunction(customDataFunction, { input, $, request, response, html })
                    : null,
            };

            if (saveHtml) data.html = html;

            // Enqueue new page.
            const nextPageUrl = $('#pnnext').attr('href');
            if (nextPageUrl) {
                data.hasNextPage = true;
                if (request.userData.page < maxPagesPerQuery - 1 && maxPagesPerQuery) {
                    await requestQueue.addRequest(createSerpRequest(`http://${parsedUrl.host}${nextPageUrl}`, request.userData.page + 1));
                } else {
                    log.info(`Not enqueueing next page for query "${parsedUrl.query.q}" because the "maxPagesPerQuery" limit has been reached.`);
                }
            }

            await dataset.pushData(data);

            // Log some nice info for user.
            log.info(`Finished query "${parsedUrl.query.q}" page number ${nonzeroPage} (${getInfoStringFromResults(data)})`);
        },
        handleFailedRequestFunction: async ({ request }) => {
            await Apify.pushData({
                '#debug': createDebugInfo(request),
                '#error': true,
            });
        },
    });

    // Run the crawler.
    await crawler.run();

    const { datasetId } = dataset;
    if (datasetId) {
        log.info(`Google SERP scraping finished.

Full results in JSON format:
https://api.apify.com/v2/datasets/${datasetId}/items?format=json

Simplified organic results in JSON format:
https://api.apify.com/v2/datasets/${datasetId}/items?format=json&fields=searchQuery,organicResults&unwind=organicResults`);
    } else {
        log.info('Google SERP scraping finished.');
    }
});
