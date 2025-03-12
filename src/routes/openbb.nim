# SPDX-License-Identifier: AGPL-3.0-only
import strutils, tables, options, asyncdispatch, httpclient, asynchttpserver, os, times
import std/json
import jester
import router_utils
import ".."/[types, config, formatters]

# OpenAI API key - in production, this should be securely stored
let openaiApiKey = getEnv("OPENAI_API_KEY", "")

proc fetchKoynlabsData*(query: string): Future[JsonNode] {.async.} =
  let client = newAsyncHttpClient()
  client.headers = newHttpHeaders({"Content-Type": "application/json"})
  
  # Create JSON payload manually
  var payload = newJObject()
  payload["query"] = newJString(query)
  
  let response = await client.post("https://api.koynlabs.com:3443/api/search", $payload)
  let body = await response.body
  
  # Parse JSON response
  result = parseJson(body)

proc processWithOpenAI*(query: string, koynData: JsonNode): Future[seq[string]] {.async.} =
  if openaiApiKey.len == 0:
    # If no API key is provided, return a simple response
    return @["I found some information about " & query & " but I need an OpenAI API key to process it properly."]
  
  let client = newAsyncHttpClient()
  client.headers = newHttpHeaders({
    "Content-Type": "application/json",
    "Authorization": "Bearer " & openaiApiKey
  })
  
  # Extract relevant data from Koynlabs response
  var items = newJArray()
  if koynData.hasKey("data") and koynData["data"].hasKey("items"):
    items = koynData["data"]["items"]
  
  # Prepare a simplified version of the data for OpenAI
  var simplifiedItems = newJArray()
  var count = 0
  for item in items:
    if count >= 10:  # Limit to 10 items to avoid token limits
      break
    
    if item.hasKey("title") and item.hasKey("creator") and item.hasKey("pubDate"):
      var simplifiedItem = newJObject()
      simplifiedItem["title"] = newJString(item["title"].getStr())
      simplifiedItem["creator"] = newJString(item["creator"].getStr())
      simplifiedItem["pubDate"] = newJString(item["pubDate"].getStr())
      if item.hasKey("description"):
        simplifiedItem["description"] = newJString(item["description"].getStr())
      else:
        simplifiedItem["description"] = newJString("")
      simplifiedItems.add(simplifiedItem)
    
    count += 1
  
  # Create the OpenAI API request
  var prompt = newJObject()
  prompt["model"] = newJString("gpt-3.5-turbo")
  
  var messages = newJArray()
  
  var systemMsg = newJObject()
  systemMsg["role"] = newJString("system")
  systemMsg["content"] = newJString("You are a helpful assistant that provides insights about cryptocurrency based on real-time data. Analyze the provided data and give a concise, informative summary about the query. Focus on key trends, important news, and relevant insights. Format your response in markdown with bullet points for clarity.")
  messages.add(systemMsg)
  
  var userMsg = newJObject()
  userMsg["role"] = newJString("user")
  userMsg["content"] = newJString("I want to know about " & query & ". Here is some real-time data from social media and news sources: " & $simplifiedItems)
  messages.add(userMsg)
  
  prompt["messages"] = messages
  prompt["temperature"] = newJFloat(0.7)
  prompt["max_tokens"] = newJInt(500)
  
  try:
    let response = await client.post("https://api.openai.com/v1/chat/completions", $prompt)
    let body = await response.body
    let jsonResponse = parseJson(body)
    
    if jsonResponse.hasKey("choices") and jsonResponse["choices"].len > 0 and 
       jsonResponse["choices"][0].hasKey("message") and 
       jsonResponse["choices"][0]["message"].hasKey("content"):
      
      let content = jsonResponse["choices"][0]["message"]["content"].getStr()
      # Split the content into smaller chunks for streaming
      var chunks: seq[string] = @[]
      var currentChunk = ""
      
      for line in content.splitLines():
        if currentChunk.len + line.len > 100:  # Limit chunk size
          chunks.add(currentChunk)
          currentChunk = line & "\n"
        else:
          currentChunk.add(line & "\n")
      
      if currentChunk.len > 0:
        chunks.add(currentChunk)
      
      return chunks
    else:
      return @["I couldn't process the information properly. Please try again."]
  except:
    return @["An error occurred while processing your request with OpenAI. Please try again later."]

proc createOpenBBRouter*(cfg: Config) =
  router openbb:
    get "/copilots.json":
      # Serve the copilots.json configuration file
      var copilotConfig = newJObject()
      var koynlabsCopilot = newJObject()
      
      koynlabsCopilot["name"] = newJString("Koynlabs Crypto Copilot")
      koynlabsCopilot["description"] = newJString("AI-powered crypto insights using real-time data from Koynlabs API.")
      koynlabsCopilot["image"] = newJString(getUrlPrefix(cfg) & "/logo.jpg")
      koynlabsCopilot["hasStreaming"] = newJBool(true)
      koynlabsCopilot["hasFunctionCalling"] = newJBool(true)
      
      var endpoints = newJObject()
      endpoints["query"] = newJString(getUrlPrefix(cfg) & "/openbb/query")
      koynlabsCopilot["endpoints"] = endpoints
      
      copilotConfig["koynlabs_copilot"] = koynlabsCopilot
      
      resp Http200, {"Content-Type": "application/json"}, $copilotConfig

    post "/openbb/query":
      # Set headers for Server-Sent Events
      let headers = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*"
      }
      
      # Parse the request body
      var reqBody: JsonNode
      try:
        reqBody = parseJson(request.body)
      except:
        resp Http400, headers, "event: error\ndata: {\"message\":\"Invalid JSON request\"}\n\n"
        return
      
      # Extract the query from the messages
      var query = ""
      if reqBody.hasKey("messages") and reqBody["messages"].len > 0:
        let lastMessage = reqBody["messages"][^1]
        if lastMessage.hasKey("role") and lastMessage["role"].getStr() == "human" and
           lastMessage.hasKey("content"):
          query = lastMessage["content"].getStr()
      
      if query.len == 0:
        resp Http400, headers, "event: error\ndata: {\"message\":\"No query found in request\"}\n\n"
        return
      
      # Create a custom response handler for SSE
      var responseContent = "event: copilotStatusUpdate\ndata: {\"status\":\"Searching for real-time crypto information...\"}\n\n"
      
      # Fetch data from Koynlabs API
      var koynData: JsonNode
      try:
        koynData = await fetchKoynlabsData(query)
      except:
        resp Http500, headers, responseContent & "event: error\ndata: {\"message\":\"Failed to fetch data from Koynlabs API\"}\n\n"
        return
      
      # Add status update
      responseContent.add("event: copilotStatusUpdate\ndata: {\"status\":\"Analyzing data with AI...\"}\n\n")
      
      # Process the data with OpenAI
      let processedChunks = await processWithOpenAI(query, koynData)
      
      # Add the processed response chunks
      for chunk in processedChunks:
        for c in chunk:
          responseContent.add("event: copilotMessageChunk\ndata: {\"delta\":\"" & $c & "\"}\n\n")
      
      # Add citations if there are items
      if koynData.hasKey("data") and koynData["data"].hasKey("items") and koynData["data"]["items"].len > 0:
        let items = koynData["data"]["items"]
        var citations = newJArray()
        var count = 0
        
        for item in items:
          if count >= 5:  # Limit to 5 citations
            break
            
          if item.hasKey("title") and item.hasKey("creator") and item.hasKey("link"):
            var citation = newJObject()
            citation["title"] = newJString(item["title"].getStr())
            citation["url"] = newJString(item["link"].getStr())
            if item.hasKey("pubDate"):
              citation["date"] = newJString(item["pubDate"].getStr())
            else:
              citation["date"] = newJString("")
            citation["source"] = newJString(item["creator"].getStr())
            citations.add(citation)
              
          count += 1
        
        if citations.len > 0:
          var citationCollection = newJObject()
          citationCollection["citations"] = citations
          
          responseContent.add("event: copilotCitationCollection\ndata: " & $citationCollection & "\n\n")
      
      # Add a final message about the source
      let finalMessage = "\n\nData sourced from Koynlabs API as of " & $now() & "."
      for c in finalMessage:
        responseContent.add("event: copilotMessageChunk\ndata: {\"delta\":\"" & $c & "\"}\n\n")
      
      # Send the complete response
      resp Http200, headers, responseContent 