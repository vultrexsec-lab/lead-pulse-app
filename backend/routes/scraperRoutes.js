const express = require('express');
const { scrapeUrl, scrapeByKeywordAndCountry } = require('../services/scraperService');

const router = express.Router();

router.post('/scrape-url', async (req, res) => {
  try {
    const url = req.body?.url;
    if (!url) {
      return res.status(400).json({ success: false, message: 'url is required' });
    }

    const leads = await scrapeUrl(url);
    return res.json({ success: true, count: leads.length, leads });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to scrape URL',
    });
  }
});

router.post('/scrape-keyword', async (req, res) => {
  try {
    const keyword = req.body?.keyword;
    const country = req.body?.country;

    if (!keyword || !country) {
      return res.status(400).json({
        success: false,
        message: 'keyword and country are required',
      });
    }

    const leads = await scrapeByKeywordAndCountry(keyword, country);
    return res.json({ success: true, count: leads.length, leads });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to scrape keyword results',
    });
  }
});

module.exports = router;
