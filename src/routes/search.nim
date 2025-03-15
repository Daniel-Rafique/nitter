# SPDX-License-Identifier: AGPL-3.0-only
import strutils, tables, options, json, asyncdispatch, httpclient
import karax/[karaxdsl, vdom]
import karax/vstyles

import jester

import router_utils
import ".."/[query, types, api, formatters, prefs]
import ../views/[general, search]

include "../views/opensearch.nimf"

export search

# Helper method to get the path from a Request
proc getPath*(req: Request): string =
  result = $(parseUri(req.path) ? filterParams(req.params))

# Helper method to get the host from a Request
proc getHost*(req: Request): string =
  result = req.headers.getOrDefault("Host")

# Helper function to generate RSS URL for search queries
proc genRss*(query: string; params: Query): string =
  if params.kind == tweets:
    result = "/search/rss?" & genQueryUrl(params)
  else:
    result = ""

const toggles = {
  "nativeretweets": "Reposts",
  "media": "Media",
  "videos": "Videos",
  "news": "News",
  "verified": "Verified",
  "native_video": "Native videos",
  "replies": "Replies",
  "links": "Links",
  "images": "Images",
  "safe": "Safe",
  "quote": "Quotes",
  "pro_video": "Pro videos"
}.toOrderedTable

# Function to fetch data from Koynlabs API
proc fetchKoynlabsData*(query: string): Future[JsonNode] {.async.} =
  let client = newAsyncHttpClient()
  client.headers = newHttpHeaders({"Content-Type": "application/json"})
  
  let payload = %*{"query": query}
  try:
    let response = await client.post("https://koyn.ai:3001/api/search", $payload)
    let body = await response.body
    result = parseJson(body)
  except:
    result = %*{"status": {"code": 500, "message": "Error fetching data"}, "data": {"items": []}}

# Function to analyze sentiment from Koynlabs data
proc analyzeSentiment*(data: JsonNode): tuple[sentiment: string, score: float] =
  var 
    positiveCount = 0
    negativeCount = 0
    totalItems = 0
  
  # Simple keyword-based sentiment analysis
  let 
    positiveWords = @["bullish", "rally", "gain", "up", "rise", "growth", "positive", "buy", "good", "great", "excellent"]
    negativeWords = @["bearish", "crash", "loss", "down", "fall", "decline", "negative", "sell", "bad", "poor", "terrible"]
  
  if data.hasKey("data") and data["data"].hasKey("items"):
    let items = data["data"]["items"]
    
    for item in items:
      if item.hasKey("title") and item.hasKey("description"):
        let 
          title = item["title"].getStr().toLowerAscii()
          description = item["description"].getStr().toLowerAscii()
          
        var itemScore = 0
        
        # Check for positive words
        for word in positiveWords:
          if word in title or word in description:
            itemScore += 1
            
        # Check for negative words
        for word in negativeWords:
          if word in title or word in description:
            itemScore -= 1
            
        if itemScore > 0:
          positiveCount += 1
        elif itemScore < 0:
          negativeCount += 1
          
        totalItems += 1
  
  if totalItems == 0:
    return ("neutral", 0.0)
    
  let sentimentScore = (positiveCount - negativeCount) / totalItems
  
  var sentiment = "neutral"
  if sentimentScore > 0.2:
    sentiment = "positive"
  elif sentimentScore < -0.2:
    sentiment = "negative"
    
  return (sentiment, sentimentScore)

# Function to render AI search results
proc renderAiSearchResults*(query: string, koynData: JsonNode, sentiment: tuple[sentiment: string, score: float]): VNode =
  let sentimentColor = case sentiment.sentiment:
    of "positive": "var(--koyn-secondary)"
    of "negative": "#ef4444"
    else: "var(--koyn-text-secondary)"
  
  buildHtml(tdiv(class="ai-search-results")):
    tdiv(class="ai-search-header"):
      h2: text "AI Analysis for \"" & query & "\""
      tdiv(class="sentiment-indicator"):
        span: text "Sentiment: "
        span(style = style((StyleAttr.color, sentimentColor))):
          text sentiment.sentiment.capitalizeAscii()
    
    tdiv(class="ai-search-summary"):
      p:
        text "Based on real-time data from social media and news sources, the sentiment around "
        strong: text query
        text " is currently "
        strong: text sentiment.sentiment
        text "."
      
      if koynData.hasKey("data") and koynData["data"].hasKey("items") and koynData["data"]["items"].len > 0:
        let items = koynData["data"]["items"]
        
        h3: text "Recent Mentions"
        ul(class="ai-search-items"):
          var count = 0
          for item in items:
            if count >= 5:  # Limit to 5 items
              break
              
            if item.hasKey("title") and item.hasKey("link"):
              li:
                a(href=item["link"].getStr()):
                  text item["title"].getStr()
                if item.hasKey("creator") and item.hasKey("pubDate"):
                  span(class="item-meta"):
                    text " by " & item["creator"].getStr() & " • " & item["pubDate"].getStr()
                  
              count += 1
      else:
        p(class="no-results"): text "No specific results found for your query."
    
    tdiv(class="ai-search-footer"):
      p: text "Data sourced from Koynlabs API"

proc renderSearch*(req: Request; query: string; params: Query; cfg: Config): Future[string] {.async.} =
  let
    prefs = getPrefs(req.cookies)
    title = query & " - Twitter Search"
    desc = "Search Twitter for " & query
    ogTitle = query & " - Twitter Search"
    path = "/search?q=" & encodeUrl(query)
    aiSearch = req.params.getOrDefault("ai") == "true"

  var
    searchQuery = query
    searchParams = params
    searchResult = ""
    aiResultsNode: VNode = nil

  if aiSearch and query.len > 0:
    try:
      let koynData = await fetchKoynlabsData(query)
      let sentiment = analyzeSentiment(koynData)
      aiResultsNode = renderAiSearchResults(query, koynData, sentiment)
    except:
      discard

  if query.len > 0:
    let tweets = await getGraphTweetSearch(searchParams)
    searchResult = $renderTweetSearch(tweets, prefs, req.getPath())

  # Create the content node
  let contentNode = buildHtml(tdiv):
    tdiv(class="container"):
      if aiSearch and aiResultsNode != nil:
        aiResultsNode
      
      if searchResult.len > 0:
        verbatim(searchResult)
      else:
        renderError("No results for this search")

  # Use renderMain which handles the navbar and other common elements
  let rss = genRss(query, searchParams)
  return renderMain(contentNode, req, cfg, prefs, title, desc, ogTitle, rss)

proc createSearchRouter*(cfg: Config) =
  router search:
    get "/search/?":
      let 
        q = @"q"
        aiSearch = @"ai" == "true"
      
      if q.len > 500:
        resp Http400, showError("Search input too long.", cfg)

      let
        prefs = cookiePrefs()
        query = initQuery(params(request))
        title = "Search" & (if q.len > 0: " (" & q & ")" else: "")
      
      # Handle AI-powered search
      if aiSearch and q.len > 0:
        let searchHtml = await renderSearch(request, q, query, cfg)
        resp Http200, {"Content-Type": "text/html; charset=utf-8"}, searchHtml
      else:
        # Regular search handling
        case query.kind
        of users:
          if "," in q:
            redirect("/" & q)
          var users: Result[User]
          try:
            users = await getGraphUserSearch(query, getCursor())
          except InternalError:
            users = Result[User](beginning: true, query: query)
          resp renderMain(renderUserSearch(users, prefs), request, cfg, prefs, title)
        of tweets:
          let
            tweets = await getGraphTweetSearch(query, getCursor())
            rss = "/search/rss?" & genQueryUrl(query)
          resp renderMain(renderTweetSearch(tweets, prefs, getPath()),
                          request, cfg, prefs, title, rss=rss)
        else:
          resp Http404, showError("Invalid search", cfg)

    get "/hashtag/@hash":
      redirect("/search?q=" & encodeUrl("#" & @"hash"))

    get "/opensearch":
      # Construct URL directly without using getUrlPrefix
      let protocol = if cfg.useHttps: "https://" else: "http://"
      let url = protocol & cfg.hostname & "/search?q="
      resp Http200, {"Content-Type": "application/opensearchdescription+xml"},
                     generateOpenSearchXML(cfg.title, cfg.hostname, url)
