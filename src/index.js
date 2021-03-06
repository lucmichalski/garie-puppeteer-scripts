const puppeteer = require("puppeteer");
const { urls, cron } = require("./config");
const logger = require("./utils/logger");
const { init, saveData } = require("./influx");
const { CronJob } = require("cron");

const main = async () => {
  if (!urls || urls.length == 0 || !urls[0].url) {
    logger.error("No URLs supplied to process! Exiting...");
    process.exit(1);
  }

  if (process.env.ENV === "dev") {
    return runProcessForDev(urls);
  }

  await init();

  try {
    if (cron) {
      return new CronJob(cron, async () => filterOnPlugin(urls).map(item => item.url && getStatsForUrl(item)), null, true, "America/Toronto", null, true);
    } else {
      logger.error("Cron config not found. Exiting...");
    }
  } catch (err) {
    logger.error(err);
  }
};

const filterOnPlugin = urls => urls.filter(url => url.plugins && url.plugins.find(plugin => plugin.name === "puppeteer-scripts"));

const getStatsByType = (type, files) => {
  const temp = {};
  temp[`${type}-numberRequested`] = files.length;
  temp[`${type}-numberNotFound`] = files.filter(file => file.status === 404).length;
  temp[`${type}-totalSize`] = files.reduce((acc, cur) => acc + cur.size, 0); // Size in bytes

  return temp;
};

const processForSize = (files, dataReceived) => {
  for (let i = 0; i < files.length; i++) {
    let received = dataReceived.find(file => file.requestId === files[i].requestId);
    if (received) files[i].size = received.encodedDataLength > 0 ? received.encodedDataLength : received.dataLength;
  }
};

const getStatsForUrl = async item => {
  const { url, plugins, label } = item;
  const { userAgent, viewport, pageWaitOn, pageGotoOptions } = plugins.find(plugin => plugin.name === "puppeteer-scripts").config;
  const images = [];
  const bundle = [];
  const dataReceived = [];

  const browser = await puppeteer.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const page = await browser.newPage();

  page._client.on("Network.dataReceived", event => dataReceived.push(event));

  page._client.on("Network.responseReceived", event => {
    const bundleTypes = ["Document", "Font", "Script", "Stylesheet"];
    const eventData = { url: event.response.url, status: event.response.status, requestId: event.requestId, size: 0 };
    if (event.type === "Image") {
      images.push(eventData);
    } else if (bundleTypes.includes(event.type)) {
      bundle.push(eventData);
    }
  });

  if (userAgent) {
    await page.setUserAgent(userAgent);
  }

  if (viewport && viewport.width && viewport.height) {
    await page.setViewport(viewport);
  }

  await page
    .setCacheEnabled(false)
    .then(() => page.goto(url, pageGotoOptions))
    .then(() => pageWaitOn && page.waitFor(pageWaitOn))
    .then(() => [images, bundle].forEach(collection => processForSize(collection, dataReceived)))
    .catch(err => logger.error(`Unable to load ${url}\n${err}`));

  const stats = {
    images: getStatsByType("images", images),
    bundle: getStatsByType("bundle", bundle)
  };

  if (process.env.ENV === "dev") {
    const tag = label ? `${url}~${label}` : url;

    logger.debug(`Data For: ${tag}`);
    logger.debug(`User Agent: ${userAgent}`);
    logger.debug(`Image Stats: ${JSON.stringify(stats.images)}`);
    logger.debug(`Bundle Stats: ${JSON.stringify(stats.bundle)}\n`);
  } else {
    await saveData(url, stats.images, label, userAgent);
    await saveData(url, stats.bundle, label, userAgent);
  }

  await browser.close();
};

const runProcessForDev = urls => {
  var urlsToProcess = filterOnPlugin(urls);
  logger.debug(`Processing ${urlsToProcess.length} items...\n`);
  urlsToProcess.map(item => item.url && getStatsForUrl(item));
};

main();

// We only want to export private functions for testing only
if (process.env.ENV === "test") {
  module.exports = { main, filterOnPlugin };
} else {
  module.exports = { main };
}
