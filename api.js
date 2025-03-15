require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { OpenAI } = require('openai');
const https = require('https');
const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');
const financialDataset = require('./financial-dataset');
const { pipeline, env } = require('@huggingface/transformers');
const { SentimentIntensityAnalyzer } = require('vader-sentiment');

const app = express();
const PORT = 3003;

// Create models cache directory
const modelsCacheDir = path.join(__dirname, 'models-cache');
if (!fs.existsSync(modelsCacheDir)) {
    fs.mkdirSync(modelsCacheDir, { recursive: true });
}

// Configure Transformers.js
env.cacheDir = modelsCacheDir;
env.allowRemoteModels = true;
// Add offline fallback configuration
env.localModelPath = path.join(__dirname, 'models-cache');
env.useCache = true;
env.useFallback = true;

// Check if VADER is properly installed
let vaderAvailable = false;
try {
  const analyzer = new SentimentIntensityAnalyzer();
  if (analyzer && typeof analyzer.polarity_scores === 'function') {
    // Test VADER with a simple input
    const result = analyzer.polarity_scores("This is a test.");
    console.log("VADER test successful:", result);
    vaderAvailable = true;
  } else {
    console.error("VADER is installed but polarity_scores function is not available");
  }
} catch (error) {
  console.error("VADER is not properly installed:", error.message);
}

// Add a function to download the model files
const downloadModelFiles = async () => {
  try {
    console.log("Downloading sentiment model files...");
    
    // Use a simpler model that's more likely to work
    const modelId = 'Xenova/distilbert-base-uncased-finetuned-sst-2-english';
    
    // Initialize the pipeline to trigger the download
    const tempClassifier = await pipeline('sentiment-analysis', modelId, {
      revision: 'main',
      quantized: false,
      progress_callback: (progress) => {
        if (progress.status === 'progress') {
          console.log(`Downloading model: ${Math.round(progress.progress * 100)}%`);
        }
      }
    });
    
    // Test the model with a simple input
    const testResult = await tempClassifier("This is a test.");
    console.log("Model test successful:", testResult);
    
    // Dispose of the temporary classifier
    if (tempClassifier.dispose) {
      await tempClassifier.dispose();
    }
    
    console.log("Sentiment model files downloaded successfully");
    return true;
  } catch (error) {
    console.error("Failed to download sentiment model files:", error);
    return false;
  }
};

// Initialize the financial dataset when the server starts
(async () => {
  try {
    await financialDataset.initializeFinancialDataset();
    console.log('Financial dataset initialized on server startup');
  } catch (error) {
    console.error('Failed to initialize financial dataset on startup:', error);
  }
})();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SSL_KEY_PATH = process.env.SSL_KEY_PATH;
const SSL_CERT_PATH = process.env.SSL_CERT_PATH;

if (!OPENAI_API_KEY) {
  console.error("WARNING: OPENAI_API_KEY not found in environment variables");
} else {
  console.log("OPENAI_API_KEY loaded successfully (length: " + OPENAI_API_KEY.length + ")");
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// let timestamp = Date.now();
// let hash = generateHash(profileId, timestamp);
// function generateHash(chatId, timestamp,) {
//   const data = `${chatId}:${timestamp}:${SECRET_KEY}`;
//   return crypto.createHash('sha256').update(data).digest('hex');
// }
// npm install axios xml2js

function stripHtmlAndDecodeEntities(html) {
    if (!html) return '';
    
    // First decode HTML entities
    let decoded = html.replace(/&lt;/g, '<')
                     .replace(/&gt;/g, '>')
                     .replace(/&amp;/g, '&')
                     .replace(/&quot;/g, '"')
                     .replace(/&#39;/g, "'")
                     .replace(/\[\[CDATA\[(.*?)\]\]>/g, '$1');
    
    // Then strip HTML tags
    return decoded.replace(/<[^>]*>/g, '')
                 .replace(/\s+/g, ' ')
                 .trim();
  }
  
  
  // Helper function to extract hashtags
  function extractHashtags(text) {
    if (!text) return [];
    const hashtagRegex = /#[\w\u0590-\u05ff]+/g;
    const matches = text.match(hashtagRegex);
    return matches ? [...new Set(matches)] : []; // Remove duplicates
  }

// Function to fetch and save the top 100 cryptocurrencies from CoinMarketCap
const fetchAndSaveCryptoData = async () => {
  try {
    if (!process.env.COINMARKETCAP_API_KEY) {
      console.log("No CoinMarketCap API key found, skipping crypto data update");
      return false;
    }
    
    const cryptoDataPath = path.join(__dirname, 'assetDetection', 'cryptoData', 'latest100.json');
    
    // Check if the file exists and when it was last modified
    if (fs.existsSync(cryptoDataPath)) {
      const stats = fs.statSync(cryptoDataPath);
      const lastModified = new Date(stats.mtime);
      const now = new Date();
      const hoursSinceLastUpdate = (now - lastModified) / (1000 * 60 * 60);
      
      // If the file was updated less than 24 hours ago, skip the update
      if (hoursSinceLastUpdate < 24) {
        console.log(`Crypto data was updated ${hoursSinceLastUpdate.toFixed(1)} hours ago, skipping update`);
        return true;
      }
    }
    
    console.log("Fetching top 100 cryptocurrencies from CoinMarketCap...");
    
    const response = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest', {
      headers: {
        'X-CMC_PRO_API_KEY': process.env.COINMARKETCAP_API_KEY
      },
      params: {
        limit: 100, // Get top 100 cryptocurrencies
        sort: 'market_cap',
        sort_dir: 'desc'
      }
    });
    
    if (!response.data || !response.data.data || !Array.isArray(response.data.data)) {
      console.error("Invalid response from CoinMarketCap API");
      return false;
    }
    
    // Transform the data to match the expected format
    const transformedData = {
      data: {
        constituents: response.data.data.map(crypto => ({
          id: crypto.id,
          name: crypto.name,
          symbol: crypto.symbol,
          url: `https://coinmarketcap.com/currencies/${crypto.slug}`,
          weight: crypto.quote.USD.market_cap || 0
        }))
      },
      status: response.data.status,
      lastUpdated: new Date().toISOString() // Add a timestamp for when the data was last updated
    };
    
    // Ensure the directory exists
    const dir = path.dirname(cryptoDataPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    fs.writeFileSync(cryptoDataPath, JSON.stringify(transformedData, null, 2));
    console.log(`Saved ${transformedData.data.constituents.length} cryptocurrencies to ${cryptoDataPath}`);
    
    return true;
  } catch (error) {
    console.error("Error fetching crypto data from CoinMarketCap:", error.message);
    return false;
  }
};

const loadCryptoData = async () => {
  try {
    // Load from the local file
    const cryptoDataPath = path.join(__dirname, 'assetDetection', 'cryptoData', 'latest100.json');
    
    // Check if the file exists
    if (!fs.existsSync(cryptoDataPath)) {
      console.log("Crypto data file doesn't exist yet, creating initial data");
      
      // Create initial data
      if (process.env.COINMARKETCAP_API_KEY) {
        try {
          const response = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest', {
            headers: {
              'X-CMC_PRO_API_KEY': process.env.COINMARKETCAP_API_KEY
            },
            params: {
              limit: 100,
              sort: 'market_cap',
              sort_dir: 'desc'
            }
          });
          
          if (response.data && response.data.data) {
            // Transform the data to match the expected format
            const transformedData = {
              data: {
                constituents: response.data.data.map(crypto => ({
                  id: crypto.id,
                  name: crypto.name,
                  symbol: crypto.symbol,
                  url: `https://coinmarketcap.com/currencies/${crypto.slug}`,
                  weight: crypto.quote.USD.market_cap || 0
                }))
              },
              status: response.data.status,
              lastUpdated: new Date().toISOString()
            };
            
            // Ensure the directory exists
            const dir = path.dirname(cryptoDataPath);
            if (!fs.existsSync(dir)) {
              fs.mkdirSync(dir, { recursive: true });
            }
            
            fs.writeFileSync(cryptoDataPath, JSON.stringify(transformedData, null, 2));
            console.log(`Created initial crypto data file with ${transformedData.data.constituents.length} cryptocurrencies`);
          }
        } catch (apiError) {
          console.error("Error creating initial crypto data:", apiError.message);
          createDefaultCryptoData(cryptoDataPath);
        }
      } else {
        createDefaultCryptoData(cryptoDataPath);
      }
    } else {
      // Check if we need to update the data
      await fetchAndSaveCryptoData().catch(err => {
        console.error("Background crypto data update failed:", err.message);
      });
    }
    
    const rawData = fs.readFileSync(cryptoDataPath, 'utf8');
    const cryptoData = JSON.parse(rawData);
    
    console.log(`Loaded ${cryptoData.data.constituents.length} cryptocurrencies from local data`);
    
    // Transform the data into a more usable format for asset detection
    const cryptoMap = {};
    
    cryptoData.data.constituents.forEach(crypto => {
      // Add by name (lowercase for case-insensitive matching)
      cryptoMap[crypto.name.toLowerCase()] = {
        id: crypto.id.toString(),
        name: crypto.name,
        symbol: crypto.symbol,
        type: 'crypto',
        url: crypto.url,
        weight: crypto.weight
      };
      
      // Also add by symbol for easier matching
      cryptoMap[crypto.symbol.toLowerCase()] = {
        id: crypto.id.toString(),
        name: crypto.name,
        symbol: crypto.symbol,
        type: 'crypto',
        url: crypto.url,
        weight: crypto.weight
      };
      
      // Add common aliases for major cryptocurrencies
      if (crypto.symbol.toLowerCase() === 'btc') {
        cryptoMap['bitcoin'] = cryptoMap[crypto.symbol.toLowerCase()];
        cryptoMap['xbt'] = cryptoMap[crypto.symbol.toLowerCase()];
      } else if (crypto.symbol.toLowerCase() === 'eth') {
        cryptoMap['ethereum'] = cryptoMap[crypto.symbol.toLowerCase()];
        cryptoMap['ether'] = cryptoMap[crypto.symbol.toLowerCase()];
      } else if (crypto.symbol.toLowerCase() === 'xrp') {
        cryptoMap['ripple'] = cryptoMap[crypto.symbol.toLowerCase()];
      }
    });
    
    return cryptoMap;
  } catch (error) {
    console.error("Error loading crypto data:", error);
    return {};
  }
};

// Helper function to create default crypto data
const createDefaultCryptoData = (cryptoDataPath) => {
  // Create a minimal default data structure
  const defaultData = {
    data: {
      constituents: [
        {
          id: 1,
          name: "Bitcoin",
          symbol: "BTC",
          url: "https://coinmarketcap.com/currencies/bitcoin",
          weight: 1000000000000
        },
        {
          id: 1027,
          name: "Ethereum",
          symbol: "ETH",
          url: "https://coinmarketcap.com/currencies/ethereum",
          weight: 500000000000
        }
      ]
    },
    status: {
      timestamp: new Date().toISOString(),
      error_code: 0,
      error_message: "",
      elapsed: 0,
      credit_count: 0
    },
    lastUpdated: new Date().toISOString()
  };
  
  // Ensure the directory exists
  const dir = path.dirname(cryptoDataPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  fs.writeFileSync(cryptoDataPath, JSON.stringify(defaultData, null, 2));
  console.log("Created default crypto data file with Bitcoin and Ethereum");
};

// Load FX, indices, and commodities data
const loadMarketData = () => {
  try {
    const marketDataPath = path.join(__dirname, 'assetDetection', 'latest100.json');
    let marketData;
    
    try {
      // Try to read and parse the file
      const rawData = fs.readFileSync(marketDataPath, 'utf8');
      
      // Check if the file is empty
      if (!rawData || rawData.trim() === '') {
        console.log("Market data file is empty, using default data");
        marketData = getDefaultMarketData();
      } else {
        marketData = JSON.parse(rawData);
      }
    } catch (fileError) {
      // Handle file not found or JSON parse error
      console.log(`Error reading market data file: ${fileError.message}, using default data`);
      marketData = getDefaultMarketData();
    }
    
    // Create a unified map for easier lookup
    const assetMap = {};
    
    // Process FX pairs
    if (marketData.fx_pairs && Array.isArray(marketData.fx_pairs)) {
      marketData.fx_pairs.forEach(pair => {
        // Add by ID
        assetMap[pair.id.toLowerCase()] = pair;
        
        // Add by symbol
        assetMap[pair.symbol.toLowerCase()] = pair;
        
        // Add by name
        assetMap[pair.name.toLowerCase()] = pair;
        
        // Add by individual currencies
        assetMap[pair.base.toLowerCase()] = {
          ...pair,
          name: getCurrencyName(pair.base)
        };
        
        assetMap[pair.quote.toLowerCase()] = {
          ...pair,
          name: getCurrencyName(pair.quote)
        };
      });
    }
    
    // Process indices
    if (marketData.indices && Array.isArray(marketData.indices)) {
      marketData.indices.forEach(index => {
        // Add by ID
        assetMap[index.id.toLowerCase()] = index;
        
        // Add by symbol
        assetMap[index.symbol.toLowerCase()] = index;
        
        // Add by name
        assetMap[index.name.toLowerCase()] = index;
        
        // Add common variations
        if (index.name.includes('&')) {
          const simplifiedName = index.name.replace('&', 'and').toLowerCase();
          assetMap[simplifiedName] = index;
        }
      });
    }
    
    // Process commodities
    if (marketData.commodities && Array.isArray(marketData.commodities)) {
      marketData.commodities.forEach(commodity => {
        // Add by ID
        assetMap[commodity.id.toLowerCase()] = commodity;
        
        // Add by symbol
        assetMap[commodity.symbol.toLowerCase()] = commodity;
        
        // Add by name
        assetMap[commodity.name.toLowerCase()] = commodity;
        
        // Add common variations (e.g., "Crude Oil" for "Crude Oil WTI")
        if (commodity.name.includes(' ')) {
          const parts = commodity.name.split(' ');
          if (parts.length > 1) {
            const simplifiedName = parts.slice(0, 2).join(' ').toLowerCase();
            if (simplifiedName.length > 3 && !assetMap[simplifiedName]) {
              assetMap[simplifiedName] = commodity;
            }
          }
        }
      });
    }
    
    return assetMap;
  } catch (error) {
    console.error("Error loading market data:", error);
    return getDefaultMarketDataMap();
  }
};

// Function to provide default market data when the file is missing or empty
const getDefaultMarketData = () => {
  return {
    fx_pairs: [
      {
        "id": "EUR_USD",
        "name": "Euro / US Dollar",
        "symbol": "EUR/USD",
        "base": "EUR",
        "quote": "USD",
        "type": "fx"
      },
      {
        "id": "USD_JPY",
        "name": "US Dollar / Japanese Yen",
        "symbol": "USD/JPY",
        "base": "USD",
        "quote": "JPY",
        "type": "fx"
      },
      {
        "id": "GBP_USD",
        "name": "British Pound / US Dollar",
        "symbol": "GBP/USD",
        "base": "GBP",
        "quote": "USD",
        "type": "fx"
      },
      {
        "id": "USD_CHF",
        "name": "US Dollar / Swiss Franc",
        "symbol": "USD/CHF",
        "base": "USD",
        "quote": "CHF",
        "type": "fx"
      },
      {
        "id": "AUD_USD",
        "name": "Australian Dollar / US Dollar",
        "symbol": "AUD/USD",
        "base": "AUD",
        "quote": "USD",
        "type": "fx"
      }
    ],
    indices: [
      {
        "id": "SPX",
        "name": "S&P 500",
        "symbol": "SPX",
        "country": "US",
        "type": "index"
      },
      {
        "id": "DJIA",
        "name": "Dow Jones Industrial Average",
        "symbol": "DJIA",
        "country": "US",
        "type": "index"
      },
      {
        "id": "COMP",
        "name": "NASDAQ Composite",
        "symbol": "COMP",
        "country": "US",
        "type": "index"
      },
      {
        "id": "NDX",
        "name": "NASDAQ-100",
        "symbol": "NDX",
        "country": "US",
        "type": "index"
      },
      {
        "id": "RUT",
        "name": "Russell 2000",
        "symbol": "RUT",
        "country": "US",
        "type": "index"
      }
    ],
    commodities: [
      {
        "id": "GOLD",
        "name": "Gold",
        "symbol": "XAU",
        "category": "Precious Metals",
        "type": "commodity"
      },
      {
        "id": "SILVER",
        "name": "Silver",
        "symbol": "XAG",
        "category": "Precious Metals",
        "type": "commodity"
      },
      {
        "id": "CRUDE_OIL_WTI",
        "name": "Crude Oil WTI",
        "symbol": "CL",
        "category": "Energy",
        "type": "commodity"
      },
      {
        "id": "NATURAL_GAS",
        "name": "Natural Gas",
        "symbol": "NG",
        "category": "Energy",
        "type": "commodity"
      },
      {
        "id": "COPPER",
        "name": "Copper",
        "symbol": "HG",
        "category": "Base Metals",
        "type": "commodity"
      }
    ]
  };
};

// Function to provide a pre-processed map of default market data
const getDefaultMarketDataMap = () => {
  const defaultData = getDefaultMarketData();
  const assetMap = {};
  
  // Process FX pairs
  defaultData.fx_pairs.forEach(pair => {
    assetMap[pair.id.toLowerCase()] = pair;
    assetMap[pair.symbol.toLowerCase()] = pair;
    assetMap[pair.name.toLowerCase()] = pair;
  });
  
  // Process indices
  defaultData.indices.forEach(index => {
    assetMap[index.id.toLowerCase()] = index;
    assetMap[index.symbol.toLowerCase()] = index;
    assetMap[index.name.toLowerCase()] = index;
  });
  
  // Process commodities
  defaultData.commodities.forEach(commodity => {
    assetMap[commodity.id.toLowerCase()] = commodity;
    assetMap[commodity.symbol.toLowerCase()] = commodity;
    assetMap[commodity.name.toLowerCase()] = commodity;
  });
  
  return assetMap;
};

// Helper function to get full currency names
function getCurrencyName(code) {
  const currencyNames = {
    'USD': 'US Dollar',
    'EUR': 'Euro',
    'JPY': 'Japanese Yen',
    'GBP': 'British Pound',
    'AUD': 'Australian Dollar',
    'CAD': 'Canadian Dollar',
    'CHF': 'Swiss Franc',
    'CNY': 'Chinese Yuan',
    'HKD': 'Hong Kong Dollar',
    'NZD': 'New Zealand Dollar',
    'SEK': 'Swedish Krona',
    'SGD': 'Singapore Dollar',
    'NOK': 'Norwegian Krone',
    'MXN': 'Mexican Peso',
    'INR': 'Indian Rupee',
    'BRL': 'Brazilian Real',
    'ZAR': 'South African Rand',
    'RUB': 'Russian Ruble',
    'TRY': 'Turkish Lira'
  };
  
  return currencyNames[code] || `${code} Currency`;
}

// Map of stock tickers to company names
// This is needed because your CSV only contains tickers, not company names
const stockTickerToName = {
  'AAPL': 'Apple Inc.',
  'MSFT': 'Microsoft Corporation',
  'AMZN': 'Amazon.com Inc.',
  'GOOGL': 'Alphabet Inc. (Google) Class A',
  'GOOG': 'Alphabet Inc. (Google) Class C',
  'META': 'Meta Platforms Inc.',
  'TSLA': 'Tesla Inc.',
  'NVDA': 'NVIDIA Corporation',
  'BRK.B': 'Berkshire Hathaway Inc.',
  'JPM': 'JPMorgan Chase & Co.',
  'JNJ': 'Johnson & Johnson',
  'V': 'Visa Inc.',
  'UNH': 'UnitedHealth Group Inc.',
  'HD': 'Home Depot Inc.',
  'PG': 'Procter & Gamble Co.',
  'BAC': 'Bank of America Corp.',
  'MA': 'Mastercard Inc.',
  'XOM': 'Exxon Mobil Corporation',
  'AVGO': 'Broadcom Inc.',
  'CVX': 'Chevron Corporation',
  'ABBV': 'AbbVie Inc.',
  'COST': 'Costco Wholesale Corporation',
  'PFE': 'Pfizer Inc.',
  'CSCO': 'Cisco Systems Inc.',
  'TMO': 'Thermo Fisher Scientific Inc.',
  'MRK': 'Merck & Co. Inc.',
  'LLY': 'Eli Lilly and Company',
  'ABT': 'Abbott Laboratories',
  'CRM': 'Salesforce Inc.',
  'ADBE': 'Adobe Inc.',
  'WMT': 'Walmart Inc.',
  'ACN': 'Accenture plc',
  'DIS': 'The Walt Disney Company',
  'KO': 'The Coca-Cola Company',
  'PEP': 'PepsiCo Inc.',
  'VZ': 'Verizon Communications Inc.',
  'CMCSA': 'Comcast Corporation',
  'NFLX': 'Netflix Inc.',
  'NKE': 'Nike Inc.',
  'INTC': 'Intel Corporation',
  'T': 'AT&T Inc.',
  'WFC': 'Wells Fargo & Company',
  'TXN': 'Texas Instruments Inc.',
  'AMD': 'Advanced Micro Devices Inc.',
  'QCOM': 'Qualcomm Inc.',
  'IBM': 'International Business Machines Corporation',
  'PYPL': 'PayPal Holdings Inc.',
  'TMUS': 'T-Mobile US Inc.',
  'GS': 'Goldman Sachs Group Inc.',
  'SBUX': 'Starbucks Corporation',
  'MS': 'Morgan Stanley',
  'C': 'Citigroup Inc.',
  'AMGN': 'Amgen Inc.',
  'RTX': 'Raytheon Technologies Corporation',
  'ORCL': 'Oracle Corporation',
  'CAT': 'Caterpillar Inc.',
  'HON': 'Honeywell International Inc.',
  'UPS': 'United Parcel Service Inc.',
  'LOW': 'Lowe\'s Companies Inc.',
  'AXP': 'American Express Company',
  'BA': 'Boeing Company',
  'BLK': 'BlackRock Inc.',
  'GILD': 'Gilead Sciences Inc.',
  'MMM': 'Minnesota Mining and Manufacturing Company',
  'MDLZ': 'Mondelez International Inc.',
  'PM': 'Philip Morris International Inc.',
  'F': 'Ford Motor Company',
  'GM': 'General Motors Company',
  'USB': 'U.S. Bancorp',
  'BKNG': 'Booking Holdings Inc.',
  'CVS': 'CVS Health Corporation',
  'MO': 'Altria Group Inc.',
  'MDT': 'Medtronic plc',
  'BMY': 'Bristol-Myers Squibb Company',
  'COP': 'ConocoPhillips',
  'CHTR': 'Charter Communications Inc.',
  'TGT': 'Target Corporation',
  'AMT': 'American Tower Corporation',
  'SPGI': 'S&P Global Inc.',
  'MCD': 'McDonald\'s Corporation',
  'DHR': 'Danaher Corporation',
  'UNP': 'Union Pacific Corporation',
  'NEE': 'NextEra Energy Inc.',
  'LIN': 'Linde plc',
  'FDX': 'FedEx Corporation',
  'GE': 'General Electric Company',
  'AIG': 'American International Group Inc.',
  'BIIB': 'Biogen Inc.',
  'SO': 'Southern Company',
  'DOW': 'Dow Inc.',
  'DUK': 'Duke Energy Corporation',
  'KHC': 'The Kraft Heinz Company',
  'SPG': 'Simon Property Group Inc.',
  'EMR': 'Emerson Electric Co.',
  'EXC': 'Exelon Corporation',
  'DD': 'DuPont de Nemours Inc.',
  'MET': 'MetLife Inc.',
  'BK': 'The Bank of New York Mellon Corporation'
};

// Load stock data from CSV
const loadStockData = () => {
  return new Promise(async (resolve, reject) => {
    try {
      // Create a stock map to store all stock data
      const stockMap = {};
      
      // First try to load from the Hugging Face dataset
      try {
        console.log("Fetching stock list from Hugging Face...");
        
        // Define major companies for consistent availability
        const majorCompanies = {
          'apple': { id: "AAPL", name: "Apple Inc.", symbol: "AAPL", type: "stock" },
          'amazon': { id: "AMZN", name: "Amazon.com Inc.", symbol: "AMZN", type: "stock" },
          'google': { id: "GOOGL", name: "Alphabet Inc. (Google)", symbol: "GOOGL", type: "stock" },
          'microsoft': { id: "MSFT", name: "Microsoft Corporation", symbol: "MSFT", type: "stock" },
          'tesla': { id: "TSLA", name: "Tesla, Inc.", symbol: "TSLA", type: "stock" },
          'facebook': { id: "META", name: "Meta Platforms, Inc.", symbol: "META", type: "stock" },
          'meta': { id: "META", name: "Meta Platforms, Inc.", symbol: "META", type: "stock" },
          'netflix': { id: "NFLX", name: "Netflix, Inc.", symbol: "NFLX", type: "stock" },
          'nvidia': { id: "NVDA", name: "NVIDIA Corporation", symbol: "NVDA", type: "stock" }
        };
        
        // Update the URL to fetch from Hugging Face API
        const response = await axios.get('https://huggingface.co/api/datasets/chuyin0321/timeseries-daily-stocks/parquet/default/train', {
          headers: {
            'Accept': 'application/json'
          }
        });
        
        if (response.data && response.data.rows) {
          // Extract unique stock symbols and names from the dataset
          const stocksSet = new Set();
          const stocksData = [];
          
          response.data.rows.forEach(row => {
            if (row.symbol && !stocksSet.has(row.symbol)) {
              stocksSet.add(row.symbol);
              stocksData.push({
                symbol: row.symbol,
                name: row.symbol + " Stock" // Default name if not provided
              });
            }
          });
          
          console.log(`Loaded ${stocksData.length} stocks from Hugging Face dataset`);
          
          // Process each stock in the list
          stocksData.forEach(stock => {
            if (stock.symbol) {
              const ticker = stock.symbol.trim();
              const companyName = stock.name.trim();
              
              // Add by ticker (lowercase for case-insensitive matching)
              stockMap[ticker.toLowerCase()] = {
                id: ticker,
                name: companyName,
                symbol: ticker,
                type: 'stock'
              };
              
              // Also add by company name for easier matching
              stockMap[companyName.toLowerCase()] = {
                id: ticker,
                name: companyName,
                symbol: ticker,
                type: 'stock'
              };
            }
          });
          
          // Add major companies to the stock map
          Object.entries(majorCompanies).forEach(([key, value]) => {
            stockMap[key] = value;
          });
          
          resolve(stockMap);
          return;
        }
      } catch (huggingFaceError) {
        console.error("Error fetching stock list from Hugging Face:", huggingFaceError.message);
        console.log("Trying local stock data file...");
        
        // Try the local JSON file we created
        try {
          console.log("Trying local stocks.json file...");
          
          // Define major companies for consistent availability (repeated for scope)
          const majorCompanies = {
            'apple': { id: "AAPL", name: "Apple Inc.", symbol: "AAPL", type: "stock" },
            'amazon': { id: "AMZN", name: "Amazon.com Inc.", symbol: "AMZN", type: "stock" },
            'google': { id: "GOOGL", name: "Alphabet Inc. (Google)", symbol: "GOOGL", type: "stock" },
            'microsoft': { id: "MSFT", name: "Microsoft Corporation", symbol: "MSFT", type: "stock" },
            'tesla': { id: "TSLA", name: "Tesla, Inc.", symbol: "TSLA", type: "stock" },
            'facebook': { id: "META", name: "Meta Platforms, Inc.", symbol: "META", type: "stock" },
            'meta': { id: "META", name: "Meta Platforms, Inc.", symbol: "META", type: "stock" },
            'netflix': { id: "NFLX", name: "Netflix, Inc.", symbol: "NFLX", type: "stock" },
            'nvidia': { id: "NVDA", name: "NVIDIA Corporation", symbol: "NVDA", type: "stock" }
          };
          
          const localStocksPath = path.join(__dirname, 'data', 'stocks.json');
          
          if (fs.existsSync(localStocksPath)) {
            const stocksData = JSON.parse(fs.readFileSync(localStocksPath, 'utf8'));
            
            if (Array.isArray(stocksData)) {
              console.log(`Loaded ${stocksData.length} stocks from local JSON file`);
              
              // Process each stock in the list
              stocksData.forEach(stock => {
                if (stock.symbol && stock.name) {
                  const ticker = stock.symbol.trim();
                  const companyName = stock.name.trim();
                  
                  // Add by ticker (lowercase for case-insensitive matching)
                  stockMap[ticker.toLowerCase()] = {
                    id: ticker,
                    name: companyName,
                    symbol: ticker,
                    type: 'stock'
                  };
                  
                  // Also add by company name for easier matching
                  stockMap[companyName.toLowerCase()] = {
                    id: ticker,
                    name: companyName,
                    symbol: ticker,
                    type: 'stock'
                  };
                  
                  // Add common variations (without "Inc.", "Corporation", etc.)
                  const simplifiedName = companyName
                    .replace(/ Inc\.?$| Corporation$| Corp\.?$| Co\.?$| Company$| plc$| Ltd\.?$/i, '')
                    .toLowerCase();
                  
                  if (simplifiedName !== companyName.toLowerCase()) {
                    stockMap[simplifiedName] = {
                      id: ticker,
                      name: companyName,
                      symbol: ticker,
                      type: 'stock'
                    };
                  }
                }
              });
              
              // Add major companies to the stock map
              Object.entries(majorCompanies).forEach(([key, value]) => {
                stockMap[key] = value;
              });
              
              resolve(stockMap);
              return;
            }
          } else {
            console.log("Local stocks.json file not found");
          }
        } catch (localFileError) {
          console.error("Error reading local stocks.json file:", localFileError.message);
        }
      }
      
      // Fallback to local stock data if all remote fetches fail
      const stockDataPath = path.join(__dirname, 'assetDetection', 'stocksData', 'latest100.csv');
      const tickers = [];
      
      // First pass: extract header row to get all ticker symbols
      const firstLine = fs.readFileSync(stockDataPath, 'utf8').split('\n')[0];
      const headers = firstLine.split(',');
      
      // Skip the first column (Date) and process all ticker symbols
      for (let i = 1; i < headers.length; i++) {
        const ticker = headers[i].trim();
        tickers.push(ticker);
        
        // Create entries for both ticker and company name (if available)
        const companyName = stockTickerToName[ticker] || `${ticker} Stock`;
        
        stockMap[ticker.toLowerCase()] = {
          id: ticker,
          name: companyName,
          symbol: ticker,
          type: 'stock'
        };
        
        // Also add by company name for easier matching
        if (companyName) {
          stockMap[companyName.toLowerCase()] = {
            id: ticker,
            name: companyName,
            symbol: ticker,
            type: 'stock'
          };
          
          // Add common variations (without "Inc.", "Corporation", etc.)
          const simplifiedName = companyName
            .replace(/ Inc\.?$| Corporation$| Corp\.?$| Co\.?$| Company$| plc$| Ltd\.?$/i, '')
            .toLowerCase();
          
          if (simplifiedName !== companyName.toLowerCase()) {
            stockMap[simplifiedName] = {
              id: ticker,
              name: companyName,
              symbol: ticker,
              type: 'stock'
            };
          }
        }
      }
      
      console.log(`Loaded ${tickers.length} stock tickers from local data`);
      resolve(stockMap);
    } catch (error) {
      console.error("Error loading stock data:", error);
      resolve({});
    }
  });
};

const getTokenInfoFromDexScreener = async (contractAddress) => {
    try {
        const response = await axios.get(`https://api.dexscreener.com/latest/dex/search`, {
            params: {
                q: contractAddress
            }
        });
        
        if (response.data && response.data.pairs && response.data.pairs.length > 0) {
            // Return the first pair (most relevant result)
            const pair = response.data.pairs[0];
            return {
                id: pair.baseToken.address,
                name: pair.baseToken.name,
                symbol: pair.baseToken.symbol,
                type: 'crypto',
                priceUsd: pair.priceUsd,
                priceNative: pair.priceNative,
                volume24h: pair.volume.h24,
                priceChange24h: pair.priceChange.h24,
                liquidity: pair.liquidity.usd,
                marketCap: pair.marketCap,
                dexInfo: {
                    dexId: pair.dexId,
                    pairAddress: pair.pairAddress,
                    chainId: pair.chainId,
                    url: pair.url,
                    quoteToken: pair.quoteToken,
                    info: pair.info
                }
            };
        }
        return null;
    } catch (error) {
        console.error("Error fetching token info from DexScreener:", error);
        return null;
    }
};

const detectAsset = async (query) => {
    try {
        // First check if the query contains a crypto contract address
        const contractAddressRegex = /(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})/g;
        const contractAddressMatches = [...query.matchAll(contractAddressRegex)];
        
        if (contractAddressMatches.length > 0) {
            // Use the first match (most likely the contract address)
            const contractAddress = contractAddressMatches[0][0];
            const tokenInfo = await getTokenInfoFromDexScreener(contractAddress);
            
            if (tokenInfo) {
                console.log(`Found token via contract address: ${tokenInfo.name} (${tokenInfo.symbol})`);
                return tokenInfo;
            }
        }
        
        // Load all asset data
        const cryptoAssets = await loadCryptoData();
        const stockAssets = await loadStockData();
        const marketAssets = loadMarketData(); // FX, indices, commodities
        
        console.log(`Detecting assets in query: "${query}"`);
        
        // Common words to ignore
        const commonWords = ['is', 'now', 'a', 'good', 'time', 'to', 'buy', 'sell', 'invest', 'in', 'the', 'and', 
                            'or', 'for', 'should', 'i', 'my', 'about', 'what', 'how', 'when', 'price', 'value', 
                            'which', 'better', 'worse', 'best', 'worst', 'crypto', 'cryptocurrency', 'stock',
                            'market', 'trading', 'shares', 'equity', 'securities', 'commodity', 'index', 'forex',
                            'currency', 'exchange', 'rate', 'pair'];
        
        // First check for specific asset types mentioned
        const fullQuery = query.toLowerCase();
        
        if (fullQuery.includes('s&p') || fullQuery.includes('s and p') || fullQuery.includes('spx')) {
            return marketAssets['spx'];
        }
        
        if (fullQuery.includes('dow') || fullQuery.includes('djia')) {
            return marketAssets['djia'];
        }
        
        if (fullQuery.includes('nasdaq')) {
            return marketAssets['comp'];
        }
        
        // Check for stock tickers (typically 1-5 uppercase letters)
        const queryUpperCase = query.toUpperCase();
        const stockTickerRegex = /\b[A-Z]{1,5}\b/g;
        const stockTickerMatches = [...queryUpperCase.matchAll(stockTickerRegex)];
        
        for (const match of stockTickerMatches) {
            const ticker = match[0];
            if (stockAssets[ticker.toLowerCase()]) {
                const asset = stockAssets[ticker.toLowerCase()];
                console.log(`Found stock ticker: ${asset.symbol} (${asset.name})`);
                return asset;
            }
            
            // Also check if it's an index or commodity symbol
            if (marketAssets[ticker.toLowerCase()]) {
                const asset = marketAssets[ticker.toLowerCase()];
                console.log(`Found market asset symbol: ${asset.symbol} (${asset.name})`);
                return asset;
            }
        }
        
        // Split query into words and filter out common words
        const queryWords = query.toLowerCase().split(/\s+/).filter(word => !commonWords.includes(word));
        
        // Check for exact matches in all asset types
        for (const word of queryWords) {
            if (word.length < 2) continue; // Skip very short words
            
            // Check stock assets first (prioritize stocks over other assets)
            if (stockAssets[word]) {
                console.log(`Found stock match: ${stockAssets[word].name} (${stockAssets[word].symbol})`);
                return stockAssets[word];
            }
            
            // Check crypto assets
            if (cryptoAssets[word]) {
                console.log(`Found crypto asset match: ${cryptoAssets[word].name} (${cryptoAssets[word].symbol})`);
                return cryptoAssets[word];
            }
            
            // Check market assets (FX, indices, commodities)
            if (marketAssets[word]) {
                console.log(`Found market asset match: ${marketAssets[word].name} (${marketAssets[word].type})`);
                return marketAssets[word];
            }
        }
        
        // Check for currency pairs in the format XXX/YYY
        const currencyPairRegex = /([A-Z]{3})\/([A-Z]{3})/g;
        const currencyPairMatches = [...queryUpperCase.matchAll(currencyPairRegex)];
        
        if (currencyPairMatches.length > 0) {
            const pairSymbol = currencyPairMatches[0][0];
            if (marketAssets[pairSymbol.toLowerCase()]) {
                const asset = marketAssets[pairSymbol.toLowerCase()];
                console.log(`Found currency pair: ${asset.symbol} (${asset.name})`);
                return asset;
            }
        }
        
        // Improved commodity detection - check for commodity names
        const commodityKeywords = {
            'gold': { id: "GOLD", name: "Gold", symbol: "XAU", category: "Precious Metals", type: "commodity" },
            'silver': { id: "SILVER", name: "Silver", symbol: "XAG", category: "Precious Metals", type: "commodity" },
            'platinum': { id: "PLATINUM", name: "Platinum", symbol: "XPT", category: "Precious Metals", type: "commodity" },
            'palladium': { id: "PALLADIUM", name: "Palladium", symbol: "XPD", category: "Precious Metals", type: "commodity" },
            'crude oil': { id: "CRUDE_OIL_WTI", name: "Crude Oil WTI", symbol: "CL", category: "Energy", type: "commodity" },
            'crude': { id: "CRUDE_OIL_WTI", name: "Crude Oil WTI", symbol: "CL", category: "Energy", type: "commodity" },
            'oil': { id: "CRUDE_OIL_WTI", name: "Crude Oil WTI", symbol: "CL", category: "Energy", type: "commodity" },
            'brent': { id: "BRENT_CRUDE", name: "Brent Crude Oil", symbol: "BZ", category: "Energy", type: "commodity" },
            'brent crude': { id: "BRENT_CRUDE", name: "Brent Crude Oil", symbol: "BZ", category: "Energy", type: "commodity" },
            'natural gas': { id: "NATURAL_GAS", name: "Natural Gas", symbol: "NG", category: "Energy", type: "commodity" },
            'copper': { id: "COPPER", name: "Copper", symbol: "HG", category: "Base Metals", type: "commodity" },
            'aluminum': { id: "ALUMINUM", name: "Aluminum", symbol: "ALU", category: "Base Metals", type: "commodity" },
            'aluminium': { id: "ALUMINUM", name: "Aluminum", symbol: "ALU", category: "Base Metals", type: "commodity" },
            'nickel': { id: "NICKEL", name: "Nickel", symbol: "NI", category: "Base Metals", type: "commodity" },
            'zinc': { id: "ZINC", name: "Zinc", symbol: "ZNC", category: "Base Metals", type: "commodity" },
            'lead': { id: "LEAD", name: "Lead", symbol: "LD", category: "Base Metals", type: "commodity" },
            'corn': { id: "CORN", name: "Corn", symbol: "ZC", category: "Agriculture", type: "commodity" },
            'wheat': { id: "WHEAT", name: "Wheat", symbol: "ZW", category: "Agriculture", type: "commodity" },
            'soybeans': { id: "SOYBEANS", name: "Soybeans", symbol: "ZS", category: "Agriculture", type: "commodity" },
            'coffee': { id: "COFFEE", name: "Coffee", symbol: "KC", category: "Agriculture", type: "commodity" },
            'sugar': { id: "SUGAR", name: "Sugar", symbol: "SB", category: "Agriculture", type: "commodity" },
            'cotton': { id: "COTTON", name: "Cotton", symbol: "CT", category: "Agriculture", type: "commodity" },
            'cocoa': { id: "COCOA", name: "Cocoa", symbol: "CC", category: "Agriculture", type: "commodity" }
        };
        
        // Check for commodity keywords in the query
        const lowerQuery = query.toLowerCase();
        for (const [keyword, commodity] of Object.entries(commodityKeywords)) {
            if (lowerQuery.includes(keyword)) {
                console.log(`Found commodity keyword match: ${commodity.name} (${commodity.symbol})`);
                return commodity;
            }
        }
        
        // Check for commodity symbols - moved to lower priority to avoid false matches
        const commoditySymbols = {
            'XAU': commodityKeywords['gold'],
            'XAG': commodityKeywords['silver'],
            'XPT': commodityKeywords['platinum'],
            'XPD': commodityKeywords['palladium'],
            'CL': commodityKeywords['crude oil'],
            'BZ': commodityKeywords['brent crude'],
            'NG': commodityKeywords['natural gas'],
            'HG': commodityKeywords['copper'],
            'ALU': commodityKeywords['aluminum'],
            'NI': commodityKeywords['nickel'],
            'ZNC': commodityKeywords['zinc'],
            'LD': commodityKeywords['lead'],
            'ZC': commodityKeywords['corn'],
            'ZW': commodityKeywords['wheat'],
            'ZS': commodityKeywords['soybeans'],
            'KC': commodityKeywords['coffee'],
            'SB': commodityKeywords['sugar'],
            'CT': commodityKeywords['cotton'],
            'CC': commodityKeywords['cocoa']
        };
        
        // Only check for commodity symbols if they appear as standalone words
        // to avoid false matches like "LD" in "apple"
        for (const [symbol, commodity] of Object.entries(commoditySymbols)) {
            const symbolRegex = new RegExp(`\\b${symbol}\\b`, 'i');
            if (symbolRegex.test(queryUpperCase)) {
                console.log(`Found commodity symbol match: ${commodity.name} (${commodity.symbol})`);
                return commodity;
            }
        }
        
        // If we get here, no match was found
        // Default to Bitcoin as a fallback
        return {
            id: "1",
            name: "Bitcoin",
            symbol: "BTC",
            type: "crypto"
        };
    } catch (error) {
        console.error("Error detecting asset:", error);
        return {
            id: "1",
            name: "Bitcoin",
            symbol: "BTC",
            type: "crypto"
        };
    }
};

const getFinancialNews = async (asset) => {
    try {
        // Define news sources based on asset type
        let newsSources = [];
        let searchTerms = [];
        
        switch(asset.type) {
            case 'crypto':
                newsSources = ['coindesk.com', 'cointelegraph.com', 'decrypt.co', 'theblock.co', 'bloomberg.com'];
                searchTerms = [asset.name, asset.symbol, 'cryptocurrency'];
                break;
            case 'stock':
                newsSources = ['cnbc.com', 'bloomberg.com', 'reuters.com', 'wsj.com', 'marketwatch.com', 'seekingalpha.com'];
                searchTerms = [asset.name, asset.symbol, 'stock', 'earnings'];
                break;
            case 'commodity':
                newsSources = ['reuters.com', 'bloomberg.com', 'spglobal.com', 'argusmedia.com', 'cnbc.com'];
                searchTerms = [asset.name, 'commodity', 'futures', asset.category];
                break;
            case 'fx':
                newsSources = ['fxstreet.com', 'dailyfx.com', 'forexlive.com', 'reuters.com', 'bloomberg.com'];
                searchTerms = [asset.name, 'forex', 'currency', 'exchange rate'];
                break;
            case 'index':
                newsSources = ['cnbc.com', 'bloomberg.com', 'reuters.com', 'wsj.com', 'marketwatch.com'];
                searchTerms = [asset.name, 'index', 'market', asset.country];
                break;
            default:
                newsSources = ['reuters.com', 'bloomberg.com', 'cnbc.com', 'wsj.com'];
                searchTerms = [asset.name, asset.symbol];
        }
        
        // Create search query
        const query = searchTerms.join(' OR ');
        
        // Fetch news related to the query
        const response = await axios.get(`https://newsapi.org/v2/everything`, {
            params: {
                q: query,
                domains: newsSources.join(','),
                apiKey: process.env.NEWS_API_KEY,
                language: "en",
                sortBy: "publishedAt",
                pageSize: 10
            }
        });

        if (!response.data.articles || response.data.articles.length === 0) {
            throw new Error("No articles found, falling back...");
        }

        return response.data.articles.slice(0, 5).map(article => ({
            title: article.title,
            url: article.url,
            source: article.source.name,
            description: article.description || "No description available.",
            publishedAt: article.publishedAt
        }));
    } catch (error) {
        console.error("Error fetching financial news:", error.message);
        
        // Implement fallback logic - try a more general search
        try {
            const response = await axios.get(`https://newsapi.org/v2/everything`, {
                params: {
                    q: asset.name,
                    apiKey: process.env.NEWS_API_KEY,
                    language: "en",
                    sortBy: "publishedAt",
                    pageSize: 5
                }
            });
            
            if (response.data.articles && response.data.articles.length > 0) {
                return response.data.articles.map(article => ({
                    title: article.title,
                    url: article.url,
                    source: article.source.name,
                    description: article.description || "No description available.",
                    publishedAt: article.publishedAt
                }));
            }
        } catch (fallbackError) {
            console.error("Fallback news search also failed:", fallbackError.message);
        }
        
        // Return empty array if all attempts fail
        return [];
    }
};

const getAssetData = async (asset) => {
    try {
        let price;
        
        // If asset has priceUsd from DexScreener, use that
        if (asset.priceUsd) {
            price = asset.priceUsd;
        } else {
            // Try primary data source first
            try {
                price = await getPrimaryAssetPrice(asset);
                console.log(`Successfully fetched price for ${asset.name} from primary source: $${price}`);
            } catch (primaryError) {
                // If primary source fails, try fallback
                console.log(`Primary data source failed for ${asset.name}, trying fallback sources...`);
                const fallbackPrice = await getFallbackAssetPrice(asset);
                
                if (fallbackPrice !== "N/A") {
                    console.log(`Successfully fetched price for ${asset.name} from fallback source: $${fallbackPrice}`);
                    price = fallbackPrice;
                } else {
                    // If we get here, all API sources have failed
                    console.error(`All API sources failed for ${asset.name}`);
                    price = "N/A";
                }
            }
        }
        
        // Get financial insights from the dataset
        let financialInsights = null;
        try {
            financialInsights = await financialDataset.getFinancialInsights(asset);
            console.log(`Retrieved financial insights for ${asset.name || asset.symbol}`);
        } catch (error) {
            console.error(`Error retrieving financial insights for ${asset.name || asset.symbol}:`, error);
        }
        
        // Return both price and financial insights
        return {
            price,
            financialInsights
        };
    } catch (error) {
        console.error(`Error in getAssetData for ${asset.name}:`, error);
        return {
            price: "N/A",
            financialInsights: null
        };
    }
};

// Update the getPrimaryAssetPrice function to better handle commodities
const getPrimaryAssetPrice = async (asset) => {
    try {
        console.log(`Fetching primary price data for ${asset.name} (${asset.type})`);
        
        switch(asset.type) {
            case 'crypto':
                // Use CoinMarketCap API as primary source for crypto
                if (process.env.COINMARKETCAP_API_KEY) {
                    try {
                        const response = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest', {
                            headers: {
                                'X-CMC_PRO_API_KEY': process.env.COINMARKETCAP_API_KEY
                            },
                            params: {
                                symbol: asset.symbol
                            }
                        });
                        
                        if (response.data && response.data.data && response.data.data[asset.symbol]) {
                            return response.data.data[asset.symbol].quote.USD.price.toFixed(2);
                        }
                    } catch (error) {
                        console.error(`CoinMarketCap API failed: ${error.message}`);
                        throw new Error(`Primary data source failed for ${asset.name}`);
                    }
                } else {
                    console.error("No CoinMarketCap API key found");
                    throw new Error(`Primary data source failed for ${asset.name}`);
                }
                
                // If we get here, CoinMarketCap failed
                break;
                
            case 'commodity':
                // Try multiple sources for commodity prices
                
                // Special handling for gold and silver to ensure accurate pricing
                if (asset.symbol === 'XAU' || asset.symbol === 'XAG') {
                    // 1. Try FMP API with forex pair first
                    if (process.env.FMP_API_KEY) {
                        try {
                            const forexSymbol = asset.symbol === 'XAU' ? 'XAUUSD' : 'XAGUSD';
                            console.log(`Trying FMP API for ${asset.name} with forex symbol: ${forexSymbol}`);
                            
                            const fmpResponse = await axios.get(`https://financialmodelingprep.com/api/v3/quote/${forexSymbol}`, {
                                params: {
                                    apikey: process.env.FMP_API_KEY
                                }
                            });
                            
                            if (fmpResponse.data && fmpResponse.data.length > 0 && fmpResponse.data[0].price) {
                                console.log(`FMP API returned price for ${asset.name}: $${fmpResponse.data[0].price}`);
                                return fmpResponse.data[0].price.toFixed(2);
                            }
                        } catch (error) {
                            console.error(`FMP API forex error for ${asset.name}:`, error.message);
                        }
                    }
                    
                    // 2. Try Alpha Vantage as second option
                    if (process.env.ALPHA_VANTAGE_API_KEY) {
                        try {
                            const baseSymbol = asset.symbol === 'XAU' ? 'XAU' : 'XAG';
                            console.log(`Trying Alpha Vantage API for ${asset.name} with forex pair: ${baseSymbol}/USD`);
                            
                            const response = await axios.get("https://www.alphavantage.co/query", {
                                params: {
                                    function: "CURRENCY_EXCHANGE_RATE",
                                    from_currency: baseSymbol,
                                    to_currency: "USD",
                                    apikey: process.env.ALPHA_VANTAGE_API_KEY
                                }
                            });
                            
                            if (response.data && 
                                response.data["Realtime Currency Exchange Rate"] && 
                                response.data["Realtime Currency Exchange Rate"]["5. Exchange Rate"]) {
                                const price = parseFloat(response.data["Realtime Currency Exchange Rate"]["5. Exchange Rate"]);
                                console.log(`Alpha Vantage API returned price for ${asset.name}: $${price}`);
                                return price.toFixed(2);
                            }
                        } catch (error) {
                            console.error(`Alpha Vantage API error for ${asset.name}:`, error.message);
                        }
                    }
                }
                
                // For other commodities or as fallback for gold/silver
                // 1. Try FMP API first
                if (process.env.FMP_API_KEY) {
                    try {
                        const fmpSymbol = getCommodityTickerForFMP(asset.symbol);
                        console.log(`Trying FMP API for ${asset.name} with symbol: ${fmpSymbol}`);
                        
                        const fmpResponse = await axios.get(`https://financialmodelingprep.com/api/v3/quote/${fmpSymbol}`, {
                            params: {
                                apikey: process.env.FMP_API_KEY
                            }
                        });
                        
                        if (fmpResponse.data && fmpResponse.data.length > 0 && fmpResponse.data[0].price) {
                            console.log(`FMP API returned price for ${asset.name}: $${fmpResponse.data[0].price}`);
                            return fmpResponse.data[0].price.toFixed(2);
                        }
                    } catch (error) {
                        console.error(`FMP API error for ${asset.name}:`, error.message);
                    }
                }
                
                // 2. Try Alpha Vantage
                if (process.env.ALPHA_VANTAGE_API_KEY) {
                    try {
                        // Map commodity symbols to Alpha Vantage symbols
                        const avSymbol = getCommodityTickerForAlphaVantage(asset.symbol);
                        console.log(`Trying Alpha Vantage for ${asset.name} with symbol: ${avSymbol}`);
                        
                        const avResponse = await axios.get("https://www.alphavantage.co/query", {
                            params: {
                                function: "GLOBAL_QUOTE",
                                symbol: avSymbol,
                                apikey: process.env.ALPHA_VANTAGE_API_KEY
                            }
                        });
                        
                        if (avResponse.data && avResponse.data["Global Quote"] && 
                            avResponse.data["Global Quote"]["05. price"]) {
                            
                            const price = parseFloat(avResponse.data["Global Quote"]["05. price"]);
                            console.log(`Alpha Vantage returned price for ${asset.name}: $${price}`);
                            return price.toFixed(2);
                        }
                    } catch (error) {
                        console.error(`Error fetching ${asset.name} price from Alpha Vantage:`, error.message);
                    }
                }
                
                // 3. Try Yahoo Finance
                try {
                    // Map commodity symbols to Yahoo Finance symbols
                    const yahooSymbol = getCommodityTickerForYahoo(asset.symbol);
                    console.log(`Trying Yahoo Finance for ${asset.name} with symbol: ${yahooSymbol}`);
                    
                    const yahooResponse = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}`, {
                        params: {
                            interval: '1d',
                            range: '1d'
                        }
                    });
                    
                    if (yahooResponse.data && yahooResponse.data.chart && 
                        yahooResponse.data.chart.result && 
                        yahooResponse.data.chart.result[0].meta && 
                        yahooResponse.data.chart.result[0].meta.regularMarketPrice) {
                        
                        const price = yahooResponse.data.chart.result[0].meta.regularMarketPrice;
                        console.log(`Yahoo Finance returned price for ${asset.name}: $${price}`);
                        return price.toFixed(2);
                    }
                } catch (error) {
                    console.error(`Error fetching ${asset.name} price from Yahoo Finance:`, error.message);
                }
                
                // If we get here, all commodity price sources failed
                throw new Error(`All commodity price sources failed for ${asset.name}`);
                
            case 'stock':
                // Use Alpha Vantage for stock prices
                if (process.env.ALPHA_VANTAGE_API_KEY) {
                    const stockResponse = await axios.get("https://www.alphavantage.co/query", {
                        params: {
                            function: "GLOBAL_QUOTE",
                            symbol: asset.symbol,
                            apikey: process.env.ALPHA_VANTAGE_API_KEY
                        }
                    });
                    
                    if (stockResponse.data && stockResponse.data["Global Quote"] && 
                        stockResponse.data["Global Quote"]["05. price"]) {
                        return parseFloat(stockResponse.data["Global Quote"]["05. price"]).toFixed(2);
                    }
                }
                break;
                
            case 'index':
                // Use Alpha Vantage for index prices with proper symbol formatting
                if (process.env.ALPHA_VANTAGE_API_KEY) {
                    // Format index symbols properly (e.g., ^SPX for S&P 500)
                    const indexSymbol = asset.symbol.startsWith('^') ? asset.symbol : `^${asset.symbol}`;
                    
                    const response = await axios.get("https://www.alphavantage.co/query", {
                        params: {
                            function: "GLOBAL_QUOTE",
                            symbol: indexSymbol,
                            apikey: process.env.ALPHA_VANTAGE_API_KEY
                        }
                    });
                    
                    if (response.data && response.data["Global Quote"] && 
                        response.data["Global Quote"]["05. price"]) {
                        return parseFloat(response.data["Global Quote"]["05. price"]).toFixed(2);
                    }
                }
                
                // Try FMP API as an alternative for indices
                if (process.env.FMP_API_KEY) {
                    const fmpSymbol = asset.symbol === 'SPX' ? 'S&P500' : 
                                     (asset.symbol === 'DJIA' ? 'DOW' : 
                                     (asset.symbol === 'COMP' ? 'NASDAQ' : asset.symbol));
                    
                    const fmpResponse = await axios.get(`https://financialmodelingprep.com/api/v3/quote/${fmpSymbol}`, {
                        params: {
                            apikey: process.env.FMP_API_KEY
                        }
                    });
                    
                    if (fmpResponse.data && fmpResponse.data.length > 0 && fmpResponse.data[0].price) {
                        return fmpResponse.data[0].price.toFixed(2);
                    }
                }
                break;
                
            case 'fx':
                // Use Alpha Vantage for FX prices with proper symbol formatting
                if (process.env.ALPHA_VANTAGE_API_KEY) {
                    // Format FX symbols properly (e.g., EURUSD for EUR/USD)
                    const fxSymbol = `${asset.base}${asset.quote}`;
                    
                    const response = await axios.get("https://www.alphavantage.co/query", {
                        params: {
                            function: "CURRENCY_EXCHANGE_RATE",
                            from_currency: asset.base,
                            to_currency: asset.quote,
                            apikey: process.env.ALPHA_VANTAGE_API_KEY
                        }
                    });
                    
                    if (response.data && 
                        response.data["Realtime Currency Exchange Rate"] && 
                        response.data["Realtime Currency Exchange Rate"]["5. Exchange Rate"]) {
                        return parseFloat(response.data["Realtime Currency Exchange Rate"]["5. Exchange Rate"]).toFixed(4);
                    }
                }
                
                // Try FMP API as an alternative for FX
                if (process.env.FMP_API_KEY) {
                    const fmpSymbol = `${asset.base}/${asset.quote}`;
                    
                    const fmpResponse = await axios.get(`https://financialmodelingprep.com/api/v3/fx/${fmpSymbol}`, {
                        params: {
                            apikey: process.env.FMP_API_KEY
                        }
                    });
                    
                    if (fmpResponse.data && fmpResponse.data.length > 0 && fmpResponse.data[0].price) {
                        return fmpResponse.data[0].price.toFixed(4);
                    }
                }
                break;
        }
        
        // If we get here, the primary source failed
        throw new Error(`Primary data source failed for ${asset.name}`);
    } catch (error) {
        console.error(`Primary data source error for ${asset.name}:`, error.message);
        throw error; // Propagate the error to be handled by getFallbackAssetPrice
    }
};

// Add new helper functions for mapping commodity symbols to different API formats
const getCommodityTickerForFMP = (symbol) => {
    // Map commodity symbols to FMP API tickers
    const commodityMap = {
        'XAU': 'XAUUSD', // Use XAUUSD for Gold instead of GOLD (which is Barrick Gold stock)
        'XAG': 'XAGUSD', // Use XAGUSD for Silver
        'OIL': 'USOIL',
        'BRENT': 'UKOIL',
        'NG': 'NATURALGAS',
        'COPPER': 'COPPER',
        'WHEAT': 'WHEAT',
        'CORN': 'CORN',
        'SOYBEAN': 'SOYBEAN',
        'COFFEE': 'COFFEE',
        'SUGAR': 'SUGAR',
        'COTTON': 'COTTON'
    };
    
    return commodityMap[symbol] || symbol;
};

const getCommodityTickerForAlphaVantage = (symbol) => {
    const mapping = {
        'XAU': 'XAUUSD',    // Gold - Use direct forex pair instead of futures
        'XAG': 'XAGUSD',    // Silver - Use direct forex pair instead of futures
        'XPT': 'PL=F',      // Platinum Futures
        'XPD': 'PA=F',      // Palladium Futures
        'CL': 'CL=F',       // Crude Oil WTI Futures
        'BZ': 'BZ=F',       // Brent Crude Oil Futures
        'NG': 'NG=F',       // Natural Gas Futures
        'HG': 'HG=F',       // Copper Futures
        'ALU': 'ALI=F',     // Aluminum Futures
        'NI': 'NI=F',       // Nickel Futures
        'ZNC': 'ZN=F',      // Zinc Futures
        'LD': 'LD=F',       // Lead Futures
        'ZC': 'ZC=F',       // Corn Futures
        'ZW': 'ZW=F',       // Wheat Futures
        'ZS': 'ZS=F',       // Soybean Futures
        'KC': 'KC=F',       // Coffee Futures
        'SB': 'SB=F',       // Sugar Futures
        'CT': 'CT=F',       // Cotton Futures
        'CC': 'CC=F'        // Cocoa Futures
    };
    
    return mapping[symbol] || symbol;
};

const getCommodityTickerForYahoo = (symbol) => {
    const mapping = {
        'XAU': 'XAUUSD=X',  // Gold - Use direct forex pair instead of futures
        'XAG': 'XAGUSD=X',  // Silver - Use direct forex pair instead of futures
        'XPT': 'PL=F',      // Platinum Futures
        'XPD': 'PA=F',      // Palladium Futures
        'CL': 'CL=F',       // Crude Oil WTI Futures
        'BZ': 'BZ=F',       // Brent Crude Oil Futures
        'NG': 'NG=F',       // Natural Gas Futures
        'HG': 'HG=F',       // Copper Futures
        'ALU': 'ALI=F',     // Aluminum Futures
        'NI': 'NI=F',       // Nickel Futures
        'ZNC': 'ZN=F',      // Zinc Futures
        'LD': 'LD=F',       // Lead Futures
        'ZC': 'ZC=F',       // Corn Futures
        'ZW': 'ZW=F',       // Wheat Futures
        'ZS': 'ZS=F',       // Soybean Futures
        'KC': 'KC=F',       // Coffee Futures
        'SB': 'SB=F',       // Sugar Futures
        'CT': 'CT=F',       // Cotton Futures
        'CC': 'CC=F'        // Cocoa Futures
    };
    
    // For ETFs as alternatives
    const etfMapping = {
        'XAU': 'GLD',       // SPDR Gold Shares ETF
        'XAG': 'SLV',       // iShares Silver Trust ETF
        'CL': 'USO',        // United States Oil Fund ETF
        'NG': 'UNG'         // United States Natural Gas Fund ETF
    };
    
    return mapping[symbol] || etfMapping[symbol] || symbol;
};

// Update the getFallbackAssetPrice function to use more sources for commodities
const getFallbackAssetPrice = async (asset) => {
    try {
        console.log(`Trying fallback sources for ${asset.name} (${asset.type})`);
        
        switch(asset.type) {
            case 'commodity':
                // Special handling for gold and silver
                if (asset.symbol === 'XAU' || asset.symbol === 'XAG') {
                    // Try Yahoo Finance with forex symbols
                    try {
                        const yahooSymbol = asset.symbol === 'XAU' ? 'XAUUSD=X' : 'XAGUSD=X';
                        console.log(`Trying Yahoo Finance API for ${asset.name} with forex symbol: ${yahooSymbol}`);
                        
                        const yahooResponse = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}`, {
                            params: {
                                interval: '1d',
                                range: '1d'
                            }
                        });
                        
                        if (yahooResponse.data && 
                            yahooResponse.data.chart && 
                            yahooResponse.data.chart.result && 
                            yahooResponse.data.chart.result[0].meta && 
                            yahooResponse.data.chart.result[0].meta.regularMarketPrice) {
                            
                            const price = yahooResponse.data.chart.result[0].meta.regularMarketPrice;
                            console.log(`Yahoo Finance returned price for ${asset.name}: $${price}`);
                            return price.toFixed(2);
                        }
                    } catch (error) {
                        console.error(`Yahoo Finance API error for ${asset.name}:`, error.message);
                    }
                }
                
                // Try ETF proxies for commodities
                try {
                    // Get ETF symbol that tracks this commodity
                    const etfSymbol = getCommodityETFProxy(asset.symbol);
                    console.log(`Trying ETF proxy for ${asset.name}: ${etfSymbol}`);
                    
                    if (etfSymbol) {
                        const yahooResponse = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${etfSymbol}`, {
                            params: {
                                interval: '1d',
                                range: '1d'
                            }
                        });
                        
                        if (yahooResponse.data && yahooResponse.data.chart && 
                            yahooResponse.data.chart.result && 
                            yahooResponse.data.chart.result[0].meta && 
                            yahooResponse.data.chart.result[0].meta.regularMarketPrice) {
                            
                            const etfPrice = yahooResponse.data.chart.result[0].meta.regularMarketPrice;
                            const commodityPrice = convertETFPriceToCommodityPrice(asset.symbol, etfPrice);
                            
                            console.log(`ETF proxy ${etfSymbol} price: $${etfPrice}, converted ${asset.name} price: $${commodityPrice}`);
                            return commodityPrice.toFixed(2);
                        }
                    }
                } catch (error) {
                    console.error(`ETF proxy fallback failed for ${asset.name}:`, error.message);
                }
                
                // Try MarketData API
                try {
                    console.log(`Trying MarketData API for ${asset.name}`);
                    const marketDataSymbol = getCommodityTickerForMarketData(asset.symbol);
                    
                    const marketDataResponse = await axios.get(`https://api.marketdata.app/v1/commodities/${marketDataSymbol}/quote`);
                    
                    if (marketDataResponse.data && marketDataResponse.data.c) {
                        console.log(`MarketData API returned price for ${asset.name}: $${marketDataResponse.data.c}`);
                        return marketDataResponse.data.c.toFixed(2);
                    }
                } catch (error) {
                    console.error(`MarketData API fallback failed for ${asset.name}:`, error.message);
                }
                
                // Try Metals-API for precious metals
                if (['XAU', 'XAG', 'XPT', 'XPD'].includes(asset.symbol) && process.env.METALS_API_KEY) {
                    try {
                        console.log(`Trying Metals-API for ${asset.name}`);
                        
                        const metalsResponse = await axios.get('https://metals-api.com/api/latest', {
                            params: {
                                access_key: process.env.METALS_API_KEY,
                                base: 'USD',
                                symbols: asset.symbol
                            }
                        });
                        
                        if (metalsResponse.data && metalsResponse.data.success && metalsResponse.data.rates) {
                            const rate = metalsResponse.data.rates[asset.symbol];
                            if (rate) {
                                // Metals-API returns rates as USD per ounce, so we need to invert
                                const price = 1 / rate;
                                console.log(`Metals-API returned price for ${asset.name}: $${price}`);
                                return price.toFixed(2);
                            }
                        }
                    } catch (error) {
                        console.error(`Metals-API fallback failed for ${asset.name}:`, error.message);
                    }
                }
                break;
                
            case 'crypto':
                // Try FMP API as fallback for crypto
                if (process.env.FMP_API_KEY) {
                    try {
                        const fmpResponse = await axios.get(`https://financialmodelingprep.com/api/v3/quote/${asset.symbol}USD`, {
                            params: {
                                apikey: process.env.FMP_API_KEY
                            }
                        });
                        
                        if (fmpResponse.data && fmpResponse.data.length > 0 && fmpResponse.data[0].price) {
                            return fmpResponse.data[0].price.toFixed(2);
                        }
                    } catch (error) {
                        console.error(`FMP crypto fallback failed: ${error.message}`);
                    }
                }
                
                // Try Yahoo Finance as another fallback for crypto
                try {
                    const yahooSymbol = `${asset.symbol}-USD`;
                    console.log(`Trying Yahoo Finance for ${asset.name} with symbol: ${yahooSymbol}`);
                    
                    const yahooResponse = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}`, {
                        params: {
                            interval: '1d',
                            range: '1d'
                        }
                    });
                    
                    if (yahooResponse.data && 
                        yahooResponse.data.chart && 
                        yahooResponse.data.chart.result && 
                        yahooResponse.data.chart.result[0].meta && 
                        yahooResponse.data.chart.result[0].meta.regularMarketPrice) {
                        
                        const price = yahooResponse.data.chart.result[0].meta.regularMarketPrice;
                        console.log(`Yahoo Finance returned price for ${asset.name}: $${price}`);
                        return price.toFixed(2);
                    }
                } catch (error) {
                    console.error(`Yahoo Finance fallback failed for ${asset.name}:`, error.message);
                }
                
                break;
                
            case 'stock':
            case 'index':
                // Try FMP API as fallback for stocks and indices
                if (process.env.FMP_API_KEY) {
                    try {
                        const symbol = asset.type === 'index' ? 
                                      (asset.symbol === 'SPX' ? 'S&P500' : 
                                      (asset.symbol === 'DJIA' ? 'DOW' : 
                                      (asset.symbol === 'COMP' ? 'NASDAQ' : asset.symbol))) : 
                                      asset.symbol;
                        
                        const fmpResponse = await axios.get(`https://financialmodelingprep.com/api/v3/quote/${symbol}`, {
                            params: {
                                apikey: process.env.FMP_API_KEY
                            }
                        });
                        
                        if (fmpResponse.data && fmpResponse.data.length > 0 && fmpResponse.data[0].price) {
                            return fmpResponse.data[0].price.toFixed(2);
                        }
                    } catch (error) {
                        console.error(`FMP stock/index fallback failed: ${error.message}`);
                    }
                }
                
                // Try Yahoo Finance API as another fallback
                try {
                    const symbol = asset.type === 'index' ? `^${asset.symbol}` : asset.symbol;
                    const yahooResponse = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`, {
                        params: {
                            interval: '1d',
                            range: '1d'
                        }
                    });
                    
                    if (yahooResponse.data && yahooResponse.data.chart && 
                        yahooResponse.data.chart.result && 
                        yahooResponse.data.chart.result[0].meta && 
                        yahooResponse.data.chart.result[0].meta.regularMarketPrice) {
                        
                        return yahooResponse.data.chart.result[0].meta.regularMarketPrice.toFixed(2);
                    }
                } catch (error) {
                    console.error(`Yahoo Finance fallback failed: ${error.message}`);
                }
                break;
                
            case 'fx':
                // Try Yahoo Finance as fallback for FX
                try {
                    const symbol = `${asset.base}${asset.quote}=X`;
                    const yahooResponse = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`, {
                        params: {
                            interval: '1d',
                            range: '1d'
                        }
                    });
                    
                    if (yahooResponse.data && yahooResponse.data.chart && 
                        yahooResponse.data.chart.result && 
                        yahooResponse.data.chart.result[0].meta && 
                        yahooResponse.data.chart.result[0].meta.regularMarketPrice) {
                        
                        return yahooResponse.data.chart.result[0].meta.regularMarketPrice.toFixed(4);
                    }
                } catch (error) {
                    console.error(`Yahoo Finance FX fallback failed: ${error.message}`);
                }
                break;
        }
        
        // If all fallbacks fail, return N/A
        console.error(`All fallback sources failed for ${asset.name}`);
        return "N/A";
    } catch (error) {
        console.error(`Fallback data source error for ${asset.name}:`, error);
        return "N/A";
    }
};

// Helper function to get ETF proxies for commodities
const getCommodityETFProxy = (symbol) => {
    const mapping = {
        'XAU': 'GLD',       // SPDR Gold Shares ETF
        'XAG': 'SLV',       // iShares Silver Trust ETF
        'XPT': 'PPLT',      // Aberdeen Physical Platinum Shares ETF
        'XPD': 'PALL',      // Aberdeen Physical Palladium Shares ETF
        'CL': 'USO',        // United States Oil Fund ETF
        'BZ': 'BNO',        // United States Brent Oil Fund ETF
        'NG': 'UNG',        // United States Natural Gas Fund ETF
        'HG': 'CPER',       // United States Copper Index Fund ETF
        'ZC': 'CORN',       // Teucrium Corn Fund ETF
        'ZW': 'WEAT',       // Teucrium Wheat Fund ETF
        'ZS': 'SOYB',       // Teucrium Soybean Fund ETF
    };
    
    return mapping[symbol] || null;
};

// Helper function to convert ETF prices to commodity prices
const convertETFPriceToCommodityPrice = (symbol, etfPrice) => {
    // Conversion factors based on how ETFs track the underlying commodity
    const conversionFactors = {
        'XAU': 0.1,         // Each GLD share represents approximately 0.1 oz of gold
        'XAG': 0.93,        // Each SLV share represents approximately 0.93 oz of silver
        'XPT': 0.1,         // Approximate conversion for platinum
        'XPD': 0.1,         // Approximate conversion for palladium
        'CL': 1,            // Approximate conversion for oil
        'BZ': 1,            // Approximate conversion for brent
        'NG': 1,            // Approximate conversion for natural gas
        'HG': 1,            // Approximate conversion for copper
        'ZC': 1,            // Approximate conversion for corn
        'ZW': 1,            // Approximate conversion for wheat
        'ZS': 1             // Approximate conversion for soybeans
    };
    
    const factor = conversionFactors[symbol] || 1;
    
    // For gold and silver, we need to divide the ETF price by the factor to get the commodity price
    if (symbol === 'XAU' || symbol === 'XAG') {
        return etfPrice / factor;
    }
    
    // For other commodities, we use the factor as a multiplier
    return etfPrice * factor;
};

// Helper function to map commodity symbols to MarketData API format
const getCommodityTickerForMarketData = (symbol) => {
    const mapping = {
        'XAU': 'XAUUSD',    // Gold - Use direct forex pair for more accurate pricing
        'XAG': 'XAGUSD',    // Silver - Use direct forex pair for more accurate pricing
        'XPT': 'PL',        // Platinum
        'XPD': 'PA',        // Palladium
        'CL': 'CL',         // Crude Oil WTI
        'BZ': 'BZ',         // Brent Crude Oil
        'NG': 'NG',         // Natural Gas
        'HG': 'HG',         // Copper
        'ZC': 'ZC',         // Corn
        'ZW': 'ZW',         // Wheat
        'ZS': 'ZS',         // Soybeans
        'KC': 'KC',         // Coffee
        'SB': 'SB',         // Sugar
        'CT': 'CT',         // Cotton
        'CC': 'CC'          // Cocoa
    };
    
    return mapping[symbol] || symbol;
};

const getHistoricalData = async (asset) => {
    try {
        // If we have DexScreener data but no historical data,
        // generate some dummy data based on the current price
        if (asset.priceUsd && !asset.historicalData) {
            const basePrice = parseFloat(asset.priceUsd);
            const dummyData = [];
            const now = Date.now();
            
            for (let i = 0; i < 10; i++) {
                const timePoint = now - (9 - i) * 3600000; // hourly points going back from now
                const randomVariation = (Math.random() - 0.5) * 0.02 * basePrice; // ±1% variation
                dummyData.push([timePoint, basePrice + randomVariation]);
            }
            
            return dummyData;
        }
        
        // For crypto assets, try to get data from CoinMarketCap first
        if (asset.type === 'crypto' && process.env.COINMARKETCAP_API_KEY) {
            try {
                console.log(`Fetching CoinMarketCap data for ${asset.name} (${asset.symbol})`);
                
                // Get current price and percent changes from CoinMarketCap
                const response = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest', {
                    headers: {
                        'X-CMC_PRO_API_KEY': process.env.COINMARKETCAP_API_KEY
                    },
                    params: {
                        symbol: asset.symbol
                    }
                });
                
                if (response.data && 
                    response.data.data && 
                    response.data.data[asset.symbol]) {
                    
                    const cryptoData = response.data.data[asset.symbol];
                    const currentPrice = cryptoData.quote.USD.price;
                    const percentChange1h = cryptoData.quote.USD.percent_change_1h || 0;
                    const percentChange24h = cryptoData.quote.USD.percent_change_24h || 0;
                    
                    console.log(`Got CoinMarketCap data for ${asset.name}: $${currentPrice}, 1h: ${percentChange1h}%, 24h: ${percentChange24h}%`);
                    
                    // Generate 120 data points (about 1 day of 5-minute intervals)
                    const dataPoints = 120;
                    const simulatedData = [];
                    const now = Date.now();
                    const timeStep = 5 * 60 * 1000; // 5 minutes in milliseconds
                    
                    // Calculate price 24 hours ago based on 24h percent change
                    const price24hAgo = currentPrice / (1 + (percentChange24h / 100));
                    
                    // Calculate price 1 hour ago based on 1h percent change
                    const price1hAgo = currentPrice / (1 + (percentChange1h / 100));
                    
                    // Create a realistic price curve
                    for (let i = 0; i < dataPoints; i++) {
                        const timePoint = now - (dataPoints - 1 - i) * timeStep;
                        
                        let price;
                        if (i >= dataPoints - 12) { // Last hour (12 points at 5-min intervals)
                            // Interpolate between 1h ago and current price
                            const ratio = (i - (dataPoints - 12)) / 11;
                            price = price1hAgo + (currentPrice - price1hAgo) * ratio;
                        } else {
                            // Interpolate between 24h ago and 1h ago
                            const ratio = i / (dataPoints - 12);
                            price = price24hAgo + (price1hAgo - price24hAgo) * ratio;
                        }
                        
                        // Add some random noise to make it look realistic
                        const volatility = 0.001; // 0.1% volatility per step
                        const randomWalk = (Math.random() - 0.5) * 2 * volatility * currentPrice;
                        
                        simulatedData.push([timePoint, price + randomWalk]);
                    }
                    
                    return simulatedData;
                }
            } catch (error) {
                console.error(`Error fetching CoinMarketCap data for ${asset.name}:`, error.message);
            }
        }
        
        // Get the current price from the asset or fetch it if not available
        let currentPrice;
        if (asset.price) {
            currentPrice = parseFloat(asset.price);
        } else {
            const assetData = await getAssetData(asset);
            currentPrice = parseFloat(assetData.price);
        }
        
        if (isNaN(currentPrice) || currentPrice === 0) {
            console.log(`Invalid price for ${asset.name}, generating dummy data`);
            return generateDummyPriceData(1000); // Use a default price of 1000 if we can't get the real price
        }
        
        console.log(`Generating simulated historical data for ${asset.name} based on current price: $${currentPrice}`);
        
        // Generate 120 data points (about 1 day of 5-minute intervals)
        const dataPoints = 120;
        const simulatedData = [];
        const now = Date.now();
        const timeStep = 5 * 60 * 1000; // 5 minutes in milliseconds
        
        // Create a realistic price curve with small random variations
        // Start with a price that's within 2% of the current price
        let startingPrice = currentPrice * (1 + (Math.random() - 0.5) * 0.04);
        
        for (let i = 0; i < dataPoints; i++) {
            const timePoint = now - (dataPoints - 1 - i) * timeStep;
            
            // Create a smooth trend toward the current price
            const progressTowardsCurrent = i / (dataPoints - 1);
            const basePrice = startingPrice + (currentPrice - startingPrice) * progressTowardsCurrent;
            
            // Add some random noise to make it look realistic
            const volatility = 0.001; // 0.1% volatility per step
            const randomWalk = (Math.random() - 0.5) * 2 * volatility * currentPrice;
            
            const price = basePrice + randomWalk;
            simulatedData.push([timePoint, price]);
        }
        
        return simulatedData;
    } catch (error) {
        console.error(`Error generating historical data for ${asset.name}:`, error);
        return generateDummyPriceData(1000); // Fallback to dummy data in case of any error
    }
};

// Helper function to generate dummy price data
const generateDummyPriceData = (basePrice) => {
    const dummyData = [];
    const now = Date.now();
    
    // Generate 120 data points (about 1 day of 5-minute intervals)
    for (let i = 0; i < 120; i++) {
        const timePoint = now - (119 - i) * 5 * 60 * 1000; // 5-minute intervals
        const randomVariation = (Math.random() - 0.5) * 0.02 * basePrice; // ±1% variation
        dummyData.push([timePoint, basePrice + randomVariation]);
    }
    
    return dummyData;
};


const getTwitterSentiment = async (asset) => {
    try {
        // Create a simpler query string that won't cause URL encoding issues
        const queryText = asset.type === 'stock' ? 
            `${asset.symbol} ${asset.name} stock` : 
            `${asset.name} ${asset.symbol}`;
            
        console.log(`Fetching sentiment data for: ${queryText}`);
        
        // Use the correct endpoint with proper parameter formatting
        const response = await axios.post("https://api.koynlabs.com:3003/api/search", {
            query: queryText,
            limit: 50
        });
        
        if (response.data && response.data.data && response.data.data.items && 
            Array.isArray(response.data.data.items)) {
            const tweets = response.data.data.items
                .map(item => `${item.title} ${item.description || ''}`.trim())
                .filter(text => text.length > 0);
                
            console.log(`Found ${tweets.length} social media posts for sentiment analysis`);
            return tweets;
        }
        
        // If we can't get data from our own API, try a fallback approach
        console.log("No items found in API response, using fallback method");
        return await getFallbackSentimentData(asset);
    } catch (error) {
        console.error("Error fetching social media sentiment:", error.message);
        // Implement fallback for sentiment data
        return await getFallbackSentimentData(asset);
    }
};

// Fallback function to generate some sentiment data when API fails
const getFallbackSentimentData = async (asset) => {
    try {
        // Try to get some news headlines to use for sentiment
        const news = await getFinancialNews(asset);
        if (news && news.length > 0) {
            console.log("Using news headlines for sentiment analysis");
            return news.map(article => article.title + ". " + (article.description || ""));
        }
        
        // If no news, return some generic statements based on asset type
        console.log("No news available, using generic sentiment statements");
        return generateGenericSentimentData(asset);
    } catch (error) {
        console.error("Fallback sentiment data generation failed:", error);
        return generateGenericSentimentData(asset);
    }
};

// Generate generic sentiment statements based on asset type
const generateGenericSentimentData = (asset) => {
    const statements = [];
    
    // Add some generic statements based on asset type
    switch(asset.type) {
        case 'stock':
            statements.push(
                `${asset.name} reported quarterly earnings recently.`,
                `Investors are watching ${asset.symbol} closely in this market.`,
                `Analysts have mixed opinions on ${asset.name}'s growth prospects.`,
                `${asset.symbol} stock has been volatile in recent trading sessions.`,
                `Some traders are bullish on ${asset.name} due to new product announcements.`
            );
            break;
        case 'crypto':
            statements.push(
                `${asset.name} has seen increased trading volume recently.`,
                `Crypto enthusiasts are discussing ${asset.symbol} adoption rates.`,
                `Market sentiment around ${asset.name} remains cautiously optimistic.`,
                `${asset.symbol} price movements have been correlated with broader market trends.`,
                `Some analysts predict ${asset.name} could see increased volatility soon.`
            );
            break;
        case 'commodity':
            statements.push(
                `${asset.name} prices are being affected by global supply chain issues.`,
                `Traders are monitoring ${asset.name} inventories closely.`,
                `Demand for ${asset.name} has been fluctuating with economic indicators.`,
                `${asset.name} futures suggest market uncertainty in the short term.`,
                `Geopolitical tensions are impacting ${asset.name} price forecasts.`
            );
            break;
        case 'fx':
            statements.push(
                `${asset.name} exchange rate is responding to central bank policies.`,
                `Traders are watching ${asset.symbol} amid changing interest rate expectations.`,
                `Economic data releases have caused volatility in ${asset.name}.`,
                `${asset.symbol} technical indicators show mixed signals for traders.`,
                `Currency analysts have diverse views on ${asset.name} direction.`
            );
            break;
        case 'index':
            statements.push(
                `${asset.name} components are showing mixed performance this quarter.`,
                `Market breadth in the ${asset.name} has been narrowing recently.`,
                `Investors are reassessing ${asset.name} exposure amid economic uncertainty.`,
                `${asset.name} technical patterns suggest caution for short-term traders.`,
                `Sector rotation is affecting ${asset.name} performance this month.`
            );
            break;
        default:
            statements.push(
                `Market sentiment around ${asset.name} remains mixed.`,
                `Traders are closely monitoring ${asset.name} price movements.`,
                `Analysts have diverse opinions on ${asset.name}'s outlook.`,
                `${asset.name} has seen increased attention from investors recently.`,
                `Technical indicators for ${asset.name} show conflicting signals.`
            );
    }
    
    return statements;
};

// Initialize the sentiment analysis pipeline (this will be cached after first use)
let sentimentClassifier = null;
let modelDownloaded = false;

// Function to get or initialize the sentiment classifier
const getSentimentClassifier = async () => {
    if (!sentimentClassifier) {
        console.log("Initializing Hugging Face sentiment analysis model...");
        try {
            // Use a simpler model that's more likely to work
            sentimentClassifier = await pipeline('sentiment-analysis', 'Xenova/distilbert-base-uncased-finetuned-sst-2-english', {
                local: true,  // Use local files
                revision: 'main',
                quantized: false
            });
            console.log("Sentiment model loaded successfully");
            return sentimentClassifier;
        } catch (error) {
            console.error("Error loading sentiment model:", error);
            throw error;
        }
    }
    return sentimentClassifier;
};

// Sentiment analysis with Transformers.js
const analyzeTextWithTransformers = async (text) => {
    try {
        const classifier = await getSentimentClassifier();
        const result = await classifier(text);
        
        // Map the result to a format similar to your current implementation
        const sentiment = result[0].label.toUpperCase();
        const score = result[0].score;
        
        // Map to your existing format
        let mappedSentiment;
        if (sentiment === "POSITIVE") {
            mappedSentiment = "Positive";
        } else if (sentiment === "NEGATIVE") {
            mappedSentiment = "Negative";
        } else {
            mappedSentiment = "Neutral";
        }
        
        return {
            sentiment: mappedSentiment,
            confidence: score,
            analysis: {
                positive: sentiment === "POSITIVE" ? score : 0,
                neutral: sentiment === "NEUTRAL" ? score : 0,
                negative: sentiment === "NEGATIVE" ? score : 0
            }
        };
    } catch (error) {
        console.error("Error analyzing sentiment with Transformers.js:", error);
        throw error; // Let the caller handle the fallback
    }
};

// Correct VADER implementation
const analyzeWithVADER = (text) => {
    try {
        // The correct way to use VADER in Node.js
        const analyzer = new SentimentIntensityAnalyzer();
        
        // Check if the analyzer is properly initialized
        if (!analyzer || typeof analyzer.polarity_scores !== 'function') {
            // If VADER is not working correctly, use our rule-based approach
            throw new Error('VADER analyzer not properly initialized');
        }
        
        // Get the sentiment scores
        const result = analyzer.polarity_scores(text);
        
        // Map VADER results to your format
        let sentiment;
        if (result.compound >= 0.05) {
            sentiment = "Positive";
        } else if (result.compound <= -0.05) {
            sentiment = "Negative";
        } else {
            sentiment = "Neutral";
        }
        
        return {
            sentiment: sentiment,
            confidence: Math.abs(result.compound),
            analysis: {
                positive: result.pos,
                neutral: result.neu,
                negative: result.neg
            }
        };
    } catch (error) {
        console.error("Error in VADER analysis:", error);
        throw error; // Let the caller handle the fallback
    }
};

// Enhanced rule-based sentiment analysis as a reliable fallback
const simpleRuleBasedSentiment = (text) => {
    // Financial-specific word lists for positive and negative sentiment
    const positiveWords = [
        'good', 'great', 'excellent', 'positive', 'bull', 'bullish', 'up', 'rise', 'rising', 
        'growth', 'profit', 'gain', 'increase', 'increasing', 'outperform', 'buy', 'strong', 
        'opportunity', 'potential', 'upside', 'recovery', 'rebound', 'rally', 'boom', 'success',
        'successful', 'promising', 'improve', 'improving', 'improved', 'advantage', 'advantageous',
        'optimistic', 'optimism', 'confident', 'confidence', 'support', 'supported', 'supporting'
    ];
    
    const negativeWords = [
        'bad', 'poor', 'negative', 'bear', 'bearish', 'down', 'fall', 'falling', 'decline', 
        'declining', 'decrease', 'decreasing', 'loss', 'lose', 'losing', 'underperform', 'sell', 
        'weak', 'weakness', 'risk', 'risky', 'danger', 'dangerous', 'threat', 'threatened', 
        'threatening', 'struggle', 'struggling', 'struggled', 'concern', 'concerned', 'concerning',
        'worry', 'worried', 'worrying', 'pessimistic', 'pessimism', 'doubt', 'doubtful', 'skeptical',
        'skepticism', 'fear', 'fearful', 'recession', 'crash', 'crisis', 'problem', 'problematic'
    ];
    
    text = text.toLowerCase();
    
    // Count occurrences
    let positiveCount = 0;
    let negativeCount = 0;
    
    positiveWords.forEach(word => {
        const regex = new RegExp('\\b' + word + '\\b', 'g');
        const matches = text.match(regex);
        if (matches) positiveCount += matches.length;
    });
    
    negativeWords.forEach(word => {
        const regex = new RegExp('\\b' + word + '\\b', 'g');
        const matches = text.match(regex);
        if (matches) negativeCount += matches.length;
    });
    
    // Check for negation words that flip sentiment
    const negationWords = ['not', 'no', "don't", "doesn't", "didn't", "won't", "wouldn't", "couldn't", "shouldn't", "isn't", "aren't", "wasn't", "weren't", "haven't", "hasn't", "hadn't", "never"];
    let negationCount = 0;
    
    negationWords.forEach(word => {
        const regex = new RegExp('\\b' + word + '\\b', 'g');
        const matches = text.match(regex);
        if (matches) negationCount += matches.length;
    });
    
    // Adjust sentiment based on negation (simple approach)
    if (negationCount > 0) {
        // Swap positive and negative counts if there are an odd number of negations
        if (negationCount % 2 === 1) {
            const temp = positiveCount;
            positiveCount = negativeCount;
            negativeCount = temp;
        }
    }
    
    // Determine sentiment
    let sentiment;
    if (positiveCount > negativeCount) {
        sentiment = "Positive";
    } else if (negativeCount > positiveCount) {
        sentiment = "Negative";
    } else {
        sentiment = "Neutral";
    }
    
    // Calculate confidence (0.5-1.0 range)
    const total = positiveCount + negativeCount;
    const confidence = total > 0 
        ? 0.5 + (0.5 * Math.abs(positiveCount - negativeCount) / total)
        : 0.5;
    
    return {
        sentiment: sentiment,
        confidence: confidence,
        analysis: {
            positive: positiveCount / (total || 1),
            neutral: 1 - (positiveCount + negativeCount) / (text.split(' ').length || 1),
            negative: negativeCount / (total || 1)
        }
    };
};

// Main sentiment analysis function with fallback
const analyzeSentiment = async (tweets) => {
    // If no tweets are provided, return neutral sentiment
    if (!tweets || tweets.length === 0) {
        return {
            sentiment: "Neutral",
            confidence: 0.5,
            analysis: {
                positive: 0.33,
                neutral: 0.34,
                negative: 0.33
            }
        };
    }
    
    // Combine all tweets into a single text for analysis
    const combinedText = tweets.join(" ");
    
    // Try Transformers.js first if model was downloaded successfully
    if (modelDownloaded) {
        try {
            console.log("Attempting sentiment analysis with Transformers.js...");
            return await analyzeTextWithTransformers(combinedText);
        } catch (transformersError) {
            console.log("Transformers.js failed, falling back to VADER:", transformersError.message);
        }
    } else {
        console.log("Skipping Transformers.js (not downloaded), trying VADER...");
    }
    
    // Try VADER as first fallback if available
    if (vaderAvailable) {
        try {
            console.log("Attempting sentiment analysis with VADER...");
            return analyzeWithVADER(combinedText);
        } catch (vaderError) {
            console.log("VADER failed, using rule-based analysis:", vaderError.message);
        }
    } else {
        console.log("VADER not available, using rule-based analysis");
    }
    
    // Use simple rule-based as final fallback
    console.log("Using rule-based sentiment analysis as final fallback");
    return simpleRuleBasedSentiment(combinedText);
};

// Function to dispose of the model and free up memory
const disposeSentimentModel = async () => {
    if (sentimentClassifier) {
        try {
            await sentimentClassifier.dispose();
            sentimentClassifier = null;
            console.log("Sentiment analysis model disposed");
        } catch (error) {
            console.error("Error disposing sentiment model:", error);
        }
    }
};

// Pre-download the model during server startup
(async () => {
  try {
    console.log("Pre-downloading sentiment model...");
    modelDownloaded = await downloadModelFiles();
    if (modelDownloaded) {
      console.log("Model pre-download complete, ready for use");
    } else {
      console.log("Model pre-download failed, will attempt to use fallbacks");
    }
  } catch (error) {
    console.error("Failed to pre-download sentiment model:", error);
  }
})();

const getOpenAIAnalysis = async (asset, assetPrice, sentiment, userQuery) => {
    try {
        // Get financial insights from the dataset
        let financialInsights = { keyPoints: [], riskFactors: [], marketTrends: [], qaData: [] };
        try {
            financialInsights = await financialDataset.getFinancialInsights(asset);
            console.log(`Retrieved ${financialInsights.keyPoints.length} key points, ${financialInsights.riskFactors.length} risk factors, and ${financialInsights.marketTrends.length} market trends for ${asset.name || asset.symbol}`);
        } catch (error) {
            console.error('Error retrieving financial insights:', error);
        }

        // Format financial insights for the prompt
        const keyPointsText = financialInsights.keyPoints.length > 0 
            ? `\nKey financial points:\n${financialInsights.keyPoints.map(point => `- ${point}`).join('\n')}`
            : '';
            
        const riskFactorsText = financialInsights.riskFactors.length > 0
            ? `\nRisk factors:\n${financialInsights.riskFactors.map(risk => `- ${risk}`).join('\n')}`
            : '';
            
        const marketTrendsText = financialInsights.marketTrends.length > 0
            ? `\nMarket trends:\n${financialInsights.marketTrends.map(trend => `- ${trend}`).join('\n')}`
            : '';
            
        const qaDataText = financialInsights.qaData.length > 0
            ? `\nRelevant financial Q&A:\n${financialInsights.qaData.map(qa => `Q: ${qa.question}\nA: ${qa.answer}`).join('\n\n')}`
            : '';

        // Enhanced system prompt with financial dataset knowledge
        const systemPrompt = "You are a financial analyst with access to a comprehensive financial dataset. " +
            "Provide insights based on asset price, social sentiment, and financial data from reliable sources. " +
            "Format your response in clear paragraphs with proper spacing between them. " +
            "Tag news sources inline using <span class=\"news-source\" data-source=\"SOURCE_NAME\">[SOURCE_NAME]</span> format. " +
            "At the end of your analysis, include a 'Sources:' section with numbered links to each source you referenced. " +
            "When financial data is provided, incorporate it into your analysis to provide more accurate and reliable insights.";

        const messages = [
            { 
                role: "system", 
                content: systemPrompt
            },
            { 
                role: "user", 
                content: `${userQuery}\n\n${asset.name || asset.symbol} is currently priced at $${assetPrice}. Social media sentiment is ${sentiment.sentiment || 'Neutral'} with ${(sentiment.confidence * 100).toFixed(1)}% confidence. Should I invest?` +
                         `${keyPointsText}${riskFactorsText}${marketTrendsText}${qaDataText}` +
                         "\n\nReference these news sources in your analysis where relevant: Barron's, Investor's Business Daily, MarketWatch, Bloomberg, CNBC, Wall Street Journal, Financial Times, Reuters, CoinDesk, and CoinTelegraph. Tag each source appropriately in your response."
            }
        ];

        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages
        });

        return response.choices[0].message.content;
    } catch (error) {
        console.error("Error fetching OpenAI response:", error);
        return "Unable to retrieve analysis.";
    }
};

app.use(express.json());

// Add CORS headers to allow requests from your frontend
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.post("/api/sentiment", async (req, res) => {
    console.log("Received request:", req.body);
    const userQuery = req.body.question || "Is now a good time to buy crypto?";
    
    // Clean the query by removing punctuation and special characters
    const cleanedQuery = userQuery.replace(/[^\w\s]/g, '').toLowerCase();
    console.log(`Cleaned query for asset detection: "${cleanedQuery}"`);
    
    const asset = await detectAsset(cleanedQuery);
    const assetData = await getAssetData(asset);
    const assetPrice = assetData.price;
    const financialInsights = assetData.financialInsights;
    const priceData = await getHistoricalData(asset);
    const tweets = await getTwitterSentiment(asset);
    const sentiment = analyzeSentiment(tweets);
    
    // Enhance asset object with financial insights if available
    const enhancedAsset = {
        ...asset,
        financialInsights: financialInsights
    };
    
    const openAIResponse = await getOpenAIAnalysis(enhancedAsset, assetPrice, sentiment, userQuery);

    // Get latest news headlines
    const financialNews = await getFinancialNews(asset);

    // Mapping placeholders to news sources
    const newsSources = {
        "{{BARRONS}}": `<span class="news-source" data-source="barrons">${financialNews[0]?.source || "Barron's"}</span>`,
        "{{INVESTORS}}": `<span class="news-source" data-source="investors">${financialNews[1]?.source || "Investors.com"}</span>`,
        "{{MARKETWATCH}}": `<span class="news-source" data-source="marketwatch">${financialNews[2]?.source || "MarketWatch"}</span>`
    };

    // Replace placeholders in OpenAI response with actual news source elements
    let formattedResponse = openAIResponse;
    Object.keys(newsSources).forEach(key => {
        formattedResponse = formattedResponse.replace(key, newsSources[key]);
    });

    // Prepare chart data for Chart.js
    const chartData = {
        type: 'line',
        data: {
            labels: priceData.map((point, index) => index + 1), // X-axis labels
            datasets: [{
                label: `${asset.name} Price`,
                data: priceData.map(point => point[1]), // Y-axis values
                backgroundColor: 'rgba(75, 192, 192, 0.2)',
                borderColor: 'rgba(75, 192, 192, 1)',
                borderWidth: 1,
                radius: 0, // Hide the points, show only the line
                pointHoverRadius: 5, // Show points on hover
                pointHoverBackgroundColor: 'rgba(75, 192, 192, 1)',
                pointHoverBorderColor: '#fff',
                pointHoverBorderWidth: 2,
                tension: 0.3 // Add slight curve to the line for better aesthetics
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: {
                x: {
                    type: 'number',
                    easing: 'linear',
                    duration: 2000,
                    from: NaN, // start invisible
                    delay(ctx) {
                        if (ctx.type !== 'data' || ctx.xStarted) {
                            return 0;
                        }
                        ctx.xStarted = true;
                        return ctx.index * 10;
                    }
                },
                y: {
                    type: 'number',
                    easing: 'linear',
                    duration: 2000,
                    from: (ctx) => ctx.index === 0 ? ctx.chart.scales.y.getPixelForValue(priceData[0][1]) : ctx.chart.getDatasetMeta(ctx.datasetIndex).data[ctx.index - 1].getProps(['y'], true).y,
                    delay(ctx) {
                        if (ctx.type !== 'data' || ctx.yStarted) {
                            return 0;
                        }
                        ctx.yStarted = true;
                        return ctx.index * 10;
                    }
                }
            },
            interaction: {
                intersect: false,
                mode: 'index'
            },
            plugins: {
                tooltip: {
                    enabled: true,
                    backgroundColor: 'rgba(0, 0, 0, 0.7)',
                    titleFont: {
                        size: 14
                    },
                    bodyFont: {
                        size: 13
                    },
                    callbacks: {
                        label: function(context) {
                            let label = context.dataset.label || '';
                            if (label) {
                                label += ': ';
                            }
                            if (context.parsed.y !== null) {
                                label += new Intl.NumberFormat('en-US', { 
                                    style: 'currency', 
                                    currency: 'USD',
                                    minimumFractionDigits: 2,
                                    maximumFractionDigits: 6
                                }).format(context.parsed.y);
                            }
                            return label;
                        }
                    }
                },
                legend: {
                    display: true,
                    position: 'top',
                    labels: {
                        font: {
                            size: 12
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: false,
                    title: {
                        display: true,
                        text: 'Price (USD)'
                    }
                },
                x: {
                    type: 'linear',
                    title: {
                        display: true,
                        text: 'Time'
                    }
                }
            }
        }
    };

    // Build the response object
    const responseData = {
        question: userQuery,
        results: [
            {
                asset: {
                    name: asset.name,
                    symbol: asset.symbol,
                    type: asset.type,
                    price: assetPrice
                },
                asset_price: assetPrice,
                chart: chartData, // Include Chart.js configuration
                social_sentiment: sentiment.sentiment || "Neutral",
                analysis: formattedResponse
            }
        ],
        news: financialNews
    };

    // If it's a token with DexScreener data, add additional information
    if (asset.dexInfo) {
        responseData.results[0].asset = {
            ...responseData.results[0].asset,
            priceUsd: asset.priceUsd,
            priceNative: asset.priceNative,
            volume24h: asset.volume24h,
            priceChange24h: asset.priceChange24h,
            liquidity: asset.liquidity,
            marketCap: asset.marketCap,
            dexInfo: {
                dexId: asset.dexInfo.dexId,
                pairAddress: asset.dexInfo.pairAddress,
                chainId: asset.dexInfo.chainId,
                url: asset.dexInfo.url,
                quoteToken: asset.dexInfo.quoteToken,
                info: asset.dexInfo.info
            }
        };
    }

    res.json(responseData);
});


app.post('/api/profiles', async (req, res) => {
    const { profileId, timestamp, hash } = req.body;
  
    // Validate parameters
    if (!profileId) {
      return res.status(400).json({ 
        status: {
          code: 400,
          message: 'Missing profileId parameter'
        },
        data: null
      });
    }
  
    try {
      // Fetch RSS feed with profileId
      const response = await axios.get(`https://koynlabs.com/${profileId}/rss`);
      const parser = new xml2js.Parser({
        explicitArray: false,
        mergeAttrs: true
      });
  
      // Parse XML to JSON
      const result = await parser.parseStringPromise(response.data);
      
      // Transform the data structure and strip HTML
      const responseData = {
        status: {
          code: response.status,
          message: 'Success',
          timestamp: new Date().toISOString()
        },
        data: {
          metadata: {
            title: stripHtmlAndDecodeEntities(result.rss.channel.title),
            link: result.rss.channel.link,
            description: stripHtmlAndDecodeEntities(result.rss.channel.description),
            language: result.rss.channel.language,
            image: result.rss.channel.image
          },
          items: result.rss.channel.item.map(item => ({
            title: stripHtmlAndDecodeEntities(item.title),
            creator: stripHtmlAndDecodeEntities(item['dc:creator']),
            description: stripHtmlAndDecodeEntities(item.description),
            pubDate: item.pubDate,
            guid: item.guid,
            link: item.link
          }))
        }
      };
  
      res.json(responseData);
    } catch (error) {
      console.error('Error fetching or parsing RSS feed:', error);
      res.status(500).json({ 
        status: {
          code: error.response?.status || 500,
          message: 'Failed to fetch or parse RSS feed',
          error: error.message,
          timestamp: new Date().toISOString()
        },
        data: null
      });
    }
  });
  
  app.post('/api/search', async (req, res) => {
    const { query, timestamp, hash, limit = 20, page = 1 } = req.body;
  
    // Validate parameters
    if (!query) {
      return res.status(400).json({ 
        status: {
          code: 400,
          message: 'Missing search query parameter'
        },
        data: null
      });
    }
  
    try {
      // Calculate how many pages we need to fetch to reach the desired limit
      const pagesToFetch = Math.ceil(limit / 20);
      let allItems = [];
      let currentPage = 1;
  
      // Fetch RSS feed with search query for each page
      while (currentPage <= pagesToFetch) {
        const response = await axios.get(`https://koyn.ai/search/rss`, {
          params: {
            f: 'tweets',
            q: query,
            p: currentPage // Add page parameter
          }
        });
        
        const parser = new xml2js.Parser({
          explicitArray: false,
          mergeAttrs: true
        });
  
        // Parse XML to JSON
        const result = await parser.parseStringPromise(response.data);
        
        // Add items from this page to our collection
        if (result.rss.channel.item) {
          const items = Array.isArray(result.rss.channel.item) ? 
            result.rss.channel.item : [result.rss.channel.item];
          allItems = allItems.concat(items);
        }
  
        currentPage++;
  
        // If we've collected enough items, stop fetching more pages
        if (allItems.length >= limit) {
          break;
        }
      }
  
      // Trim to exact limit if we got more items than requested
      allItems = allItems.slice(0, limit);
      
      // Transform the data structure and strip HTML
      const responseData = {
        status: {
          code: 200,
          message: 'Success',
          timestamp: new Date().toISOString(),
          query,
          limit,
          totalResults: allItems.length,
          page
        },
        data: {
          metadata: {
            title: `Search results for "${query}"`,
            link: `https://koyn.ai/search?q=${encodeURIComponent(query)}`,
            description: `Search results for "${query}"`,
            language: "en-us"
          },
          items: allItems.map(item => ({
            title: stripHtmlAndDecodeEntities(item.title),
            creator: stripHtmlAndDecodeEntities(item['dc:creator']),
            description: stripHtmlAndDecodeEntities(item.description),
            pubDate: item.pubDate,
            guid: item.guid,
            link: item.link,
            hashtags: extractHashtags(item.description + ' ' + item.title)
          }))
        }
      };
  
      res.json(responseData);
    } catch (error) {
      console.error('Error fetching or parsing RSS feed:', error);
      res.status(500).json({ 
        status: {
          code: error.response?.status || 500,
          message: 'Failed to fetch or parse RSS feed',
          error: error.message,
          timestamp: new Date().toISOString(),
          query
        },
        data: null
      });
    }
  });

// Financial dataset endpoints
app.get('/api/financial-qa', async (req, res) => {
  try {
    const { query, limit } = req.query;
    
    if (!query) {
      return res.status(400).json({
        status: {
          code: 400,
          message: 'Missing required parameter: query',
          timestamp: new Date().toISOString()
        },
        data: null
      });
    }
    
    const results = await financialDataset.getFinancialQA(query, parseInt(limit) || 5);
    
    res.json({
      status: {
        code: 200,
        message: 'Financial QA data retrieved successfully',
        timestamp: new Date().toISOString(),
        query
      },
      data: results
    });
  } catch (error) {
    console.error('Error retrieving financial QA data:', error);
    res.status(500).json({
      status: {
        code: 500,
        message: 'Failed to retrieve financial QA data',
        error: error.message,
        timestamp: new Date().toISOString(),
        query: req.query.query
      },
      data: null
    });
  }
});

app.get('/api/financial-insights', async (req, res) => {
  try {
    const { asset } = req.query;
    
    if (!asset) {
      return res.status(400).json({
        status: {
          code: 400,
          message: 'Missing required parameter: asset',
          timestamp: new Date().toISOString()
        },
        data: null
      });
    }
    
    const assetObj = { name: asset, symbol: asset };
    const insights = await financialDataset.getFinancialInsights(assetObj);
    
    res.json({
      status: {
        code: 200,
        message: 'Financial insights retrieved successfully',
        timestamp: new Date().toISOString(),
        asset
      },
      data: insights
    });
  } catch (error) {
    console.error('Error retrieving financial insights:', error);
    res.status(500).json({
      status: {
        code: 500,
        message: 'Failed to retrieve financial insights',
        error: error.message,
        timestamp: new Date().toISOString(),
        asset: req.query.asset
      },
      data: null
    });
  }
});

const options = {
  key: fs.readFileSync(SSL_KEY_PATH),
  cert: fs.readFileSync(SSL_CERT_PATH)
};
const server = https.createServer(options, app);
server.listen(PORT, () => console.log(`HTTPS server running on port ${PORT}`));