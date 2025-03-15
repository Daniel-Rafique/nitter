const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { tableFromIPC } = require('apache-arrow');

// Import parquet-wasm correctly
let readParquet;
let initWasm;

try {
  const parquetWasm = require('parquet-wasm');
  initWasm = parquetWasm.default || parquetWasm.initWasm;
  readParquet = parquetWasm.readParquet;
} catch (error) {
  console.error('Error importing parquet-wasm:', error);
  // Provide fallback implementation
  initWasm = async () => console.log('Using fallback implementation - parquet-wasm not available');
  readParquet = () => { throw new Error('parquet-wasm not available'); };
}

// Path to store the downloaded dataset
const DATASET_DIR = path.join(__dirname, 'data');
const DATASET_PATH = path.join(DATASET_DIR, 'financial-qa.parquet');
const DATASET_URL = 'https://huggingface.co/datasets/virattt/financial-qa-10K/resolve/main/data/0.1-00000-of-00001.parquet';

// In-memory cache for the dataset
let financialDataCache = null;
let isInitialized = false;

/**
 * Initialize the financial dataset module
 */
async function initializeFinancialDataset() {
  if (isInitialized) return;
  
  try {
    // Create data directory if it doesn't exist
    if (!fs.existsSync(DATASET_DIR)) {
      fs.mkdirSync(DATASET_DIR, { recursive: true });
    }
    
    // Download the dataset if it doesn't exist
    if (!fs.existsSync(DATASET_PATH)) {
      console.log('Downloading financial dataset from Hugging Face...');
      await downloadDataset();
    }
    
    try {
      // Initialize WebAssembly for parquet
      if (typeof initWasm === 'function') {
        await initWasm();
        console.log('Parquet WASM initialized successfully');
      } else {
        console.warn('initWasm is not a function, using fallback implementation');
      }
      
      // Load the dataset into memory
      await loadDataset();
      
      isInitialized = true;
      console.log('Financial dataset initialized successfully');
    } catch (wasmError) {
      console.error('Failed to initialize WASM or load dataset:', wasmError);
      // Continue with fallback implementation
      isInitialized = true;
      console.log('Using fallback implementation for financial dataset');
    }
  } catch (error) {
    console.error('Failed to initialize financial dataset:', error);
    throw error;
  }
}

/**
 * Download the dataset from Hugging Face
 */
async function downloadDataset() {
  try {
    const response = await axios({
      method: 'get',
      url: DATASET_URL,
      responseType: 'arraybuffer'
    });
    
    fs.writeFileSync(DATASET_PATH, Buffer.from(response.data));
    console.log('Financial dataset downloaded successfully');
  } catch (error) {
    console.error('Error downloading financial dataset:', error);
    throw error;
  }
}

/**
 * Load the dataset into memory
 */
async function loadDataset() {
  try {
    if (typeof readParquet !== 'function') {
      console.warn('readParquet is not available, using fallback implementation');
      // Create a simple in-memory cache with some sample data
      financialDataCache = {
        numRows: 10,
        get: (index) => {
          const sampleData = [
            {
              question: "What are the key factors affecting gold prices?",
              answer: "Gold prices are primarily affected by inflation rates, interest rates, currency values (especially the US dollar), geopolitical uncertainty, and central bank policies regarding gold reserves. When inflation rises or economic uncertainty increases, gold often becomes more valuable as a hedge against these conditions."
            },
            {
              question: "How do interest rates impact commodity markets?",
              answer: "Higher interest rates typically lead to lower commodity prices as they increase the opportunity cost of holding non-yielding assets like commodities. They also strengthen the US dollar, making dollar-denominated commodities more expensive for holders of other currencies, potentially reducing demand."
            },
            {
              question: "What are the risks of investing in precious metals?",
              answer: "Risks include price volatility, lack of income generation (no dividends or interest), storage and insurance costs for physical metals, potential for fraud in some markets, and sensitivity to currency fluctuations, particularly the US dollar."
            },
            {
              question: "How do tariffs affect global commodity markets?",
              answer: "Tariffs can disrupt supply chains, increase costs for producers and consumers, alter trade flows, and create market uncertainty. They often lead to price volatility and can change the competitive landscape between different producing regions."
            },
            {
              question: "What economic indicators should commodity investors monitor?",
              answer: "Key indicators include GDP growth rates, inflation data, interest rate decisions, manufacturing indices (like PMI), currency exchange rates, inventory reports, weather patterns for agricultural commodities, and geopolitical developments affecting production or transportation."
            }
          ];
          
          return index < sampleData.length ? sampleData[index] : null;
        }
      };
      console.log('Created fallback financial dataset with sample data');
      return;
    }
    
    const parquetBuffer = fs.readFileSync(DATASET_PATH);
    const arrowTable = readParquet(new Uint8Array(parquetBuffer.buffer));
    financialDataCache = tableFromIPC(arrowTable.intoIPCStream());
    
    console.log(`Loaded financial dataset with ${financialDataCache.numRows} rows`);
  } catch (error) {
    console.error('Error loading financial dataset:', error);
    throw error;
  }
}

/**
 * Get financial QA data related to a specific asset or topic
 * @param {string} query - The search query
 * @param {number} limit - Maximum number of results to return
 * @returns {Array} - Array of relevant QA pairs
 */
async function getFinancialQA(query, limit = 5) {
  if (!isInitialized) {
    await initializeFinancialDataset();
  }
  
  if (!financialDataCache) {
    throw new Error('Financial dataset not loaded');
  }
  
  try {
    // Convert query to lowercase for case-insensitive matching
    const lowerQuery = query.toLowerCase();
    
    // Filter the dataset for relevant QA pairs
    const results = [];
    
    // Iterate through the dataset
    for (let i = 0; i < financialDataCache.numRows && results.length < limit; i++) {
      const row = financialDataCache.get(i);
      
      if (!row) continue;
      
      // Check if the question or answer contains the query
      if (row.question && row.question.toLowerCase().includes(lowerQuery) || 
          row.answer && row.answer.toLowerCase().includes(lowerQuery)) {
        results.push({
          question: row.question,
          answer: row.answer,
          context: row.context || null,
          relevance: calculateRelevance(row.question, row.answer, query)
        });
      }
    }
    
    // If no results found and we're using the fallback implementation,
    // return a generic response for common financial assets
    if (results.length === 0 && typeof readParquet !== 'function') {
      const commonAssets = {
        'gold': {
          question: "What factors influence gold prices?",
          answer: "Gold prices are influenced by inflation, interest rates, currency values (especially USD), geopolitical uncertainty, central bank policies, and supply/demand dynamics in jewelry and investment markets."
        },
        'silver': {
          question: "How does silver compare to gold as an investment?",
          answer: "Silver is more volatile than gold, has more industrial applications, typically outperforms gold in bull markets but falls more in bear markets, and has a historically higher gold-to-silver ratio around 60:1."
        },
        'bitcoin': {
          question: "What are the key risks of investing in Bitcoin?",
          answer: "Key risks include extreme price volatility, regulatory uncertainty, security vulnerabilities, limited adoption as currency, competition from other cryptocurrencies, and environmental concerns about energy consumption."
        },
        'oil': {
          question: "What factors affect oil prices?",
          answer: "Oil prices are affected by OPEC+ production decisions, global economic growth, geopolitical tensions, inventory levels, seasonal demand patterns, alternative energy competition, and currency fluctuations."
        },
        'stocks': {
          question: "What economic indicators impact stock markets?",
          answer: "Key indicators include interest rates, inflation data, employment reports, GDP growth, corporate earnings, consumer sentiment, manufacturing indices, and central bank policies."
        }
      };
      
      // Check if query matches any common assets
      for (const [asset, qa] of Object.entries(commonAssets)) {
        if (lowerQuery.includes(asset)) {
          results.push({
            question: qa.question,
            answer: qa.answer,
            context: null,
            relevance: 0.9
          });
          break;
        }
      }
      
      // If still no results, add a generic financial advice response
      if (results.length === 0) {
        results.push({
          question: "What are the principles of sound investing?",
          answer: "Sound investing principles include diversification across asset classes, long-term perspective, regular contributions, minimizing fees, tax efficiency, risk management appropriate to your time horizon, and avoiding emotional decisions based on market fluctuations.",
          context: null,
          relevance: 0.7
        });
      }
    }
    
    // Sort by relevance
    results.sort((a, b) => b.relevance - a.relevance);
    
    return results.slice(0, limit);
  } catch (error) {
    console.error('Error querying financial dataset:', error);
    return [];
  }
}

/**
 * Calculate relevance score between query and QA pair
 * @param {string} question - The question
 * @param {string} answer - The answer
 * @param {string} query - The search query
 * @returns {number} - Relevance score (0-1)
 */
function calculateRelevance(question, answer, query) {
  const lowerQuery = query.toLowerCase();
  const lowerQuestion = question.toLowerCase();
  const lowerAnswer = answer.toLowerCase();
  
  // Simple relevance calculation based on term frequency
  const queryTerms = lowerQuery.split(/\s+/);
  let matchCount = 0;
  
  for (const term of queryTerms) {
    if (term.length < 3) continue; // Skip short terms
    
    if (lowerQuestion.includes(term)) matchCount += 2; // Question matches are more important
    if (lowerAnswer.includes(term)) matchCount += 1;
  }
  
  return Math.min(1, matchCount / (queryTerms.length * 3));
}

/**
 * Get financial insights for a specific asset
 * @param {Object} asset - Asset information
 * @returns {Object} - Financial insights
 */
async function getFinancialInsights(asset) {
  if (!isInitialized) {
    await initializeFinancialDataset();
  }
  
  try {
    // If we're using the fallback implementation, provide asset-specific insights
    if (typeof readParquet !== 'function') {
      const assetName = (asset.name || asset.symbol || '').toLowerCase();
      
      // Fallback insights for common assets
      const fallbackInsights = {
        'gold': {
          keyPoints: [
            "Gold is traditionally seen as a hedge against inflation and currency devaluation",
            "Gold prices often move inversely to the US dollar and real interest rates",
            "Central bank purchases have been a significant driver of gold demand in recent years"
          ],
          riskFactors: [
            "Gold produces no income or dividends, creating an opportunity cost during periods of rising interest rates",
            "Gold prices can be volatile in the short term despite long-term stability",
            "Storage and insurance costs can reduce overall returns for physical gold"
          ],
          marketTrends: [
            "Geopolitical tensions typically drive increased safe-haven demand for gold",
            "Gold ETFs have made the asset more accessible to retail investors",
            "Production costs influence mining profitability and long-term supply dynamics"
          ]
        },
        'silver': {
          keyPoints: [
            "Silver has dual roles as both a precious metal and industrial commodity",
            "The gold-to-silver ratio historically averages around 60:1",
            "Silver typically has higher volatility than gold"
          ],
          riskFactors: [
            "Industrial demand fluctuations can cause price volatility",
            "Silver can underperform gold during economic downturns",
            "Mining production is often tied to other metals, making supply less responsive to price"
          ],
          marketTrends: [
            "Green energy applications including solar panels are increasing industrial demand",
            "Investment demand has grown through ETFs and digital platforms",
            "Silver typically outperforms gold in precious metal bull markets"
          ]
        },
        'bitcoin': {
          keyPoints: [
            "Bitcoin has a fixed supply cap of 21 million coins",
            "Institutional adoption has increased Bitcoin's legitimacy as an asset class",
            "Bitcoin exhibits high volatility compared to traditional assets"
          ],
          riskFactors: [
            "Regulatory uncertainty remains a significant concern for investors",
            "Energy consumption and environmental impact face increasing scrutiny",
            "Security risks including exchange hacks and private key management"
          ],
          marketTrends: [
            "Halving events historically precede bull market cycles",
            "Correlation with traditional risk assets has increased in recent years",
            "Development of layer-2 solutions aims to address scalability challenges"
          ]
        },
        'oil': {
          keyPoints: [
            "Oil prices are heavily influenced by OPEC+ production decisions",
            "Seasonal demand patterns affect short-term price movements",
            "Geopolitical tensions in producing regions can cause supply disruptions"
          ],
          riskFactors: [
            "Long-term demand faces pressure from renewable energy transition",
            "Production costs vary widely across different regions and extraction methods",
            "Storage capacity limitations can cause extreme price volatility during supply/demand imbalances"
          ],
          marketTrends: [
            "US shale production has transformed global supply dynamics",
            "Developing economies continue to drive demand growth",
            "ESG considerations are affecting investment in new production capacity"
          ]
        }
      };
      
      // Check if we have fallback insights for this asset
      for (const [key, insights] of Object.entries(fallbackInsights)) {
        if (assetName.includes(key)) {
          // Get QA data for this asset
          const qaData = await getFinancialQA(key, 3);
          
          return {
            keyPoints: insights.keyPoints,
            riskFactors: insights.riskFactors,
            marketTrends: insights.marketTrends,
            qaData: qaData
          };
        }
      }
      
      // Generic insights if no specific asset match
      const qaData = await getFinancialQA(assetName, 3);
      
      return {
        keyPoints: [
          "Diversification across asset classes helps manage portfolio risk",
          "Long-term investment horizons typically reduce the impact of short-term volatility",
          "Economic indicators like interest rates and inflation affect asset valuations"
        ],
        riskFactors: [
          "Market sentiment can drive prices away from fundamental values in the short term",
          "Liquidity constraints may affect ability to exit positions during market stress",
          "Regulatory changes can impact asset valuations and investment strategies"
        ],
        marketTrends: [
          "Technological innovation continues to disrupt traditional industries",
          "ESG considerations are increasingly influencing investment decisions",
          "Global economic integration has increased correlation between markets"
        ],
        qaData: qaData
      };
    }
    
    // Get relevant QA pairs for the asset
    const assetName = asset.name || asset.symbol || '';
    const qaData = await getFinancialQA(assetName, 10);
    
    // Extract insights from QA data
    const insights = {
      keyPoints: extractKeyPoints(qaData),
      riskFactors: extractRiskFactors(qaData),
      marketTrends: extractMarketTrends(qaData),
      qaData: qaData.slice(0, 3) // Include top 3 QA pairs
    };
    
    return insights;
  } catch (error) {
    console.error('Error getting financial insights:', error);
    return {
      keyPoints: [],
      riskFactors: [],
      marketTrends: [],
      qaData: []
    };
  }
}

/**
 * Extract key points from QA data
 * @param {Array} qaData - Array of QA pairs
 * @returns {Array} - Key points
 */
function extractKeyPoints(qaData) {
  const keyPoints = [];
  
  for (const qa of qaData) {
    if (qa.answer && qa.answer.length > 0) {
      // Extract sentences from the answer
      const sentences = qa.answer.split(/[.!?]+/).filter(s => s.trim().length > 20);
      
      // Add the first sentence as a key point if it's not too long
      if (sentences.length > 0 && sentences[0].length < 200) {
        keyPoints.push(sentences[0].trim());
      }
    }
  }
  
  return [...new Set(keyPoints)].slice(0, 5); // Remove duplicates and limit to 5
}

/**
 * Extract risk factors from QA data
 * @param {Array} qaData - Array of QA pairs
 * @returns {Array} - Risk factors
 */
function extractRiskFactors(qaData) {
  const riskFactors = [];
  
  for (const qa of qaData) {
    if (qa.question && qa.question.toLowerCase().includes('risk') && qa.answer) {
      // Extract sentences from the answer
      const sentences = qa.answer.split(/[.!?]+/).filter(s => s.trim().length > 0);
      
      for (const sentence of sentences) {
        if (sentence.toLowerCase().includes('risk') || 
            sentence.toLowerCase().includes('challenge') || 
            sentence.toLowerCase().includes('concern')) {
          riskFactors.push(sentence.trim());
        }
      }
    }
  }
  
  return [...new Set(riskFactors)].slice(0, 3); // Remove duplicates and limit to 3
}

/**
 * Extract market trends from QA data
 * @param {Array} qaData - Array of QA pairs
 * @returns {Array} - Market trends
 */
function extractMarketTrends(qaData) {
  const marketTrends = [];
  
  for (const qa of qaData) {
    if ((qa.question && (
        qa.question.toLowerCase().includes('trend') || 
        qa.question.toLowerCase().includes('market') || 
        qa.question.toLowerCase().includes('growth'))) && qa.answer) {
      
      // Extract sentences from the answer
      const sentences = qa.answer.split(/[.!?]+/).filter(s => s.trim().length > 0);
      
      for (const sentence of sentences) {
        if (sentence.toLowerCase().includes('trend') || 
            sentence.toLowerCase().includes('market') || 
            sentence.toLowerCase().includes('growth') ||
            sentence.toLowerCase().includes('increase') ||
            sentence.toLowerCase().includes('decrease')) {
          marketTrends.push(sentence.trim());
        }
      }
    }
  }
  
  return [...new Set(marketTrends)].slice(0, 3); // Remove duplicates and limit to 3
}

module.exports = {
  initializeFinancialDataset,
  getFinancialQA,
  getFinancialInsights
}; 