# SPDX-License-Identifier: AGPL-3.0-only
import strutils, asyncdispatch, httpclient, asynchttpserver, os, times
import jester
import router_utils
import ".."/[types, config, formatters]

# OpenAI API key - in production, this should be securely stored
let openaiApiKey = getEnv("OPENAI_API_KEY", "")

proc fetchKoynlabsDataForOpenBB*(query: string): Future[string] {.async.} =
  let client = newAsyncHttpClient()
  client.headers = newHttpHeaders({"Content-Type": "application/json"})
  
  # Create JSON payload using string template
  let payload = "{\"query\": \"" & query & "\"}"
  
  let response = await client.post("https://api.koynlabs.com:3443/api/search", payload)
  let body = await response.body
  
  # Return the raw JSON response
  return body

proc processWithOpenAI*(query: string, koynData: string): Future[seq[string]] {.async.} =
  if openaiApiKey.len == 0:
    # If no API key is provided, return a simple response
    return @["I found some information about " & query & " but I need an OpenAI API key to process it properly."]
  
  let client = newAsyncHttpClient()
  client.headers = newHttpHeaders({
    "Content-Type": "application/json",
    "Authorization": "Bearer " & openaiApiKey
  })
  
  # Create the OpenAI API request
  let systemContent = "You are a helpful assistant that provides insights about cryptocurrency based on real-time data. Analyze the provided data and give a concise, informative summary about the query. Focus on key trends, important news, and relevant insights. Format your response in markdown with bullet points for clarity."
  let userContent = "I want to know about " & query & ". Here is some real-time data from social media and news sources: " & koynData
  
  # Create JSON payload using string template
  let promptJson = "{" &
    "\"model\": \"gpt-3.5-turbo\"," &
    "\"messages\": [" &
      "{\"role\": \"system\", \"content\": \"" & systemContent & "\"}," &
      "{\"role\": \"user\", \"content\": \"" & userContent & "\"}" &
    "]," &
    "\"temperature\": 0.7," &
    "\"max_tokens\": 500" &
  "}"
  
  try:
    let response = await client.post("https://api.openai.com/v1/chat/completions", promptJson)
    let body = await response.body
    
    # Extract content using simple string operations
    let contentStart = body.find("\"content\":\"")
    if contentStart > 0:
      let contentStartIndex = contentStart + 11 # Length of "content":"
      let contentEndIndex = body.find("\"", contentStartIndex)
      if contentEndIndex > contentStartIndex:
        let content = body[contentStartIndex..<contentEndIndex]
        
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
    
    return @["I couldn't process the information properly. Please try again."]
  except:
    return @["An error occurred while processing your request with OpenAI. Please try again later."]

proc createOpenBBRouter*(cfg: Config) =
  router openbb:
    get "/copilots.json":
      # Serve the copilots.json configuration file
      let urlPrefix = getUrlPrefix(cfg)
      
      # Create JSON using string template
      let copilotConfig = "{" &
        "\"koynlabs_copilot\": {" &
          "\"name\": \"Koynlabs Crypto Copilot\"," &
          "\"description\": \"AI-powered crypto insights using real-time data from Koynlabs API.\"," &
          "\"image\": \"" & urlPrefix & "/logo.jpg\"," &
          "\"hasStreaming\": true," &
          "\"hasFunctionCalling\": true," &
          "\"endpoints\": {" &
            "\"query\": \"" & urlPrefix & "/openbb/query\"" &
          "}" &
        "}" &
      "}"
      
      resp Http200, {"Content-Type": "application/json"}, copilotConfig

    post "/openbb/query":
      # Set headers for Server-Sent Events
      let headers = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*"
      }
      
      # Parse the request body as a raw string
      let reqBody = request.body
      
      # Extract the query from the messages using simple string operations
      var query = ""
      let messagesStart = reqBody.find("\"messages\":")
      if messagesStart > 0:
        let lastRoleHumanStart = reqBody.rfind("\"role\":\"human\"")
        if lastRoleHumanStart > 0:
          let contentStart = reqBody.find("\"content\":\"", lastRoleHumanStart)
          if contentStart > 0:
            let contentStartIndex = contentStart + 11 # Length of "content":"
            let contentEndIndex = reqBody.find("\"", contentStartIndex)
            if contentEndIndex > contentStartIndex:
              query = reqBody[contentStartIndex..<contentEndIndex]
      
      if query.len == 0:
        resp Http400, headers, "event: error\ndata: {\"message\":\"No query found in request\"}\n\n"
        return
      
      # Create a custom response handler for SSE
      var responseContent = "event: copilotStatusUpdate\ndata: {\"status\":\"Searching for real-time crypto information...\"}\n\n"
      
      # Fetch data from Koynlabs API
      var koynData: string
      try:
        koynData = await fetchKoynlabsDataForOpenBB(query)
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
      
      # Add a final message about the source
      let finalMessage = "\n\nData sourced from Koynlabs API as of " & $now() & "."
      for c in finalMessage:
        responseContent.add("event: copilotMessageChunk\ndata: {\"delta\":\"" & $c & "\"}\n\n")
      
      # Send the complete response
      resp Http200, headers, responseContent 