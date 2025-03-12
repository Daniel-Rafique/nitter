# SPDX-License-Identifier: AGPL-3.0-only
import strutils, asyncdispatch, httpclient, asynchttpserver, os, times, json, uri
import jester
import router_utils
import ".."/[types, config, formatters]

# Enable debug logging
const DEBUG = true

proc logDebug(msg: string) =
  if DEBUG:
    echo "[DEBUG] " & msg

# OpenAI API key - get from environment variable
let openaiApiKey = getEnv("OPENAI_API_KEY", "")
if openaiApiKey.len == 0:
  echo "WARNING: OPENAI_API_KEY environment variable is not set. OpenAI functionality will be limited."
  echo "Set it using: export OPENAI_API_KEY=\"your-api-key-here\""
else:
  echo "OpenAI API key found with length: ", openaiApiKey.len

proc escapeJsonString(s: string): string =
  result = ""
  for c in s:
    case c
    of '\\': result.add("\\\\")
    of '\"': result.add("\\\"")
    of '\n': result.add("\\n")
    of '\r': result.add("\\r")
    of '\t': result.add("\\t")
    of '\b': result.add("\\b")
    of '\f': result.add("\\f")
    else: result.add(c)

proc fetchKoynlabsDataForOpenBB*(query: string): Future[string] {.async.} =
  logDebug("Fetching data from Koynlabs for query: " & query)
  let client = newAsyncHttpClient()
  client.headers = newHttpHeaders({"Content-Type": "application/json"})
  
  # Create JSON payload with proper escaping
  let escapedQuery = escapeJsonString(query)
  let payload = "{\"query\": \"" & escapedQuery & "\"}"
  
  logDebug("Sending payload to Koynlabs: " & payload)
  
  try:
    let response = await client.post("https://api.koynlabs.com:3443/api/search", payload)
    let body = await response.body
    
    logDebug("Received response from Koynlabs: " & body[0..min(200, body.len-1)] & "...")
    
    # Return the raw JSON response
    return body
  except Exception as e:
    logDebug("Error fetching from Koynlabs: " & e.msg)
    raise e

proc processWithOpenAI*(query: string, koynData: string): Future[seq[string]] {.async.} =
  logDebug("Processing with OpenAI for query: " & query)
  
  if openaiApiKey.len == 0:
    logDebug("No OpenAI API key provided")
    # If no API key is provided, return a more helpful response
    return @[
      "I found information about " & query & " but I need an OpenAI API key to process it properly.\n\n",
      "To set up the OpenAI API key:\n",
      "1. Get an API key from https://platform.openai.com/api-keys\n",
      "2. Set it as an environment variable before starting the server:\n",
      "   export OPENAI_API_KEY=\"your-api-key-here\"\n",
      "3. Restart the server and try again."
    ]
  
  let client = newAsyncHttpClient()
  client.headers = newHttpHeaders({
    "Content-Type": "application/json",
    "Authorization": "Bearer " & openaiApiKey
  })
  
  # Create the OpenAI API request with proper escaping
  let systemContent = escapeJsonString("You are a helpful assistant that provides insights about cryptocurrency based on real-time data. Analyze the provided data and give a concise, informative summary about the query. Focus on key trends, important news, and relevant insights. Format your response in markdown with bullet points for clarity.")
  let userContent = escapeJsonString("I want to know about " & query & ". Here is some real-time data from social media and news sources: " & koynData)
  
  # Create JSON payload with proper escaping
  let promptJson = "{" &
    "\"model\": \"gpt-3.5-turbo\"," &
    "\"messages\": [" &
      "{\"role\": \"system\", \"content\": \"" & systemContent & "\"}," &
      "{\"role\": \"user\", \"content\": \"" & userContent & "\"}" &
    "]," &
    "\"temperature\": 0.7," &
    "\"max_tokens\": 500" &
  "}"
  
  logDebug("Sending request to OpenAI with payload length: " & $promptJson.len)
  
  try:
    let response = await client.post("https://api.openai.com/v1/chat/completions", promptJson)
    let body = await response.body
    
    logDebug("Received response from OpenAI: " & body[0..min(200, body.len-1)] & "...")
    
    # Extract content using simple string operations with improved robustness
    let contentStart = body.find("\"content\":\"")
    if contentStart > 0:
      let contentStartIndex = contentStart + 11 # Length of "content":"
      var contentEndIndex = body.find("\"", contentStartIndex)
      
      # Handle escaped quotes within the content
      var tempIndex = contentStartIndex
      while tempIndex < contentEndIndex:
        if body[tempIndex] == '\\' and tempIndex + 1 < body.len and body[tempIndex + 1] == '"':
          # Found an escaped quote, need to find the next unescaped quote
          tempIndex += 2
          contentEndIndex = body.find("\"", tempIndex)
          if contentEndIndex < 0:
            break
        else:
          tempIndex += 1
      
      if contentEndIndex > contentStartIndex:
        var content = body[contentStartIndex..<contentEndIndex]
        
        # Unescape the content
        content = content.replace("\\\"", "\"")
        content = content.replace("\\n", "\n")
        content = content.replace("\\r", "\r")
        content = content.replace("\\t", "\t")
        content = content.replace("\\\\", "\\")
        
        logDebug("Extracted content: " & content[0..min(100, content.len-1)] & "...")
        
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
        
        logDebug("Split content into " & $chunks.len & " chunks")
        return chunks
    
    logDebug("Failed to extract content from OpenAI response")
    return @["I couldn't process the information properly. Please try again."]
  except Exception as e:
    logDebug("Error processing with OpenAI: " & e.msg)
    return @["An error occurred while processing your request with OpenAI: " & e.msg & ". Please try again later."]

proc createOpenBBRouter*(cfg: Config) =
  router openbb:
    get "/copilots.json":
      # Serve the copilots.json configuration file
      let urlPrefix = getUrlPrefix(cfg)
      
      logDebug("Serving copilots.json with urlPrefix: " & urlPrefix)
      
      # Create JSON using string template with proper escaping
      let copilotConfig = "{" &
        "\"example_copilot\": {" &
          "\"name\": \"Example Co. Copilot\"," &
          "\"description\": \"AI-powered financial analyst fine-tuned by Example Co. to answer in the company-approved tone.\"," &
          "\"image\": \"https://github.com/OpenBB-finance/copilot-for-terminal-pro/assets/14093308/7da2a512-93b9-478d-90bc-b8c3dd0cabcf\"," &
          "\"hasStreaming\": true," &
          "\"hasDocuments\": false," &
          "\"hasFunctionCalling\": false," &
          "\"endpoints\": {" &
            "\"query\": \"" & urlPrefix & "/openbb/query\"" &
          "}" &
        "}" &
      "}"
      
      resp Http200, {"Content-Type": "application/json"}, copilotConfig

    post "/openbb/query":
      logDebug("Received query request")
      
      # Set headers for Server-Sent Events
      let headers = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*"
      }
      
      # Parse the request body as a raw string
      let reqBody = request.body
      logDebug("Request body: " & reqBody[0..min(200, reqBody.len-1)] & "...")
      
      # Extract the query from the messages using simple string operations with improved robustness
      var query = ""
      let messagesStart = reqBody.find("\"messages\":")
      if messagesStart > 0:
        let lastRoleHumanStart = reqBody.rfind("\"role\":\"human\"")
        if lastRoleHumanStart > 0:
          let contentStart = reqBody.find("\"content\":\"", lastRoleHumanStart)
          if contentStart > 0:
            let contentStartIndex = contentStart + 11 # Length of "content":"
            var contentEndIndex = reqBody.find("\"", contentStartIndex)
            
            # Handle escaped quotes within the content
            var tempIndex = contentStartIndex
            while tempIndex < contentEndIndex:
              if reqBody[tempIndex] == '\\' and tempIndex + 1 < reqBody.len and reqBody[tempIndex + 1] == '"':
                # Found an escaped quote, need to find the next unescaped quote
                tempIndex += 2
                contentEndIndex = reqBody.find("\"", tempIndex)
                if contentEndIndex < 0:
                  break
              else:
                tempIndex += 1
            
            if contentEndIndex > contentStartIndex:
              query = reqBody[contentStartIndex..<contentEndIndex]
              # Unescape the query
              query = query.replace("\\\"", "\"")
              query = query.replace("\\n", "\n")
              query = query.replace("\\r", "\r")
              query = query.replace("\\t", "\t")
              query = query.replace("\\\\", "\\")
      
      logDebug("Extracted query: " & query)
      
      if query.len == 0:
        logDebug("No query found in request")
        resp Http400, headers, "event: error\ndata: {\"message\":\"No query found in request\"}\n\n"
        return
      
      # Create a custom response handler for SSE
      var responseContent = "event: copilotStatusUpdate\ndata: {\"status\":\"Searching for real-time crypto information...\"}\n\n"
      
      # Fetch data from Koynlabs API
      var koynData: string
      try:
        koynData = await fetchKoynlabsDataForOpenBB(query)
      except Exception as e:
        logDebug("Failed to fetch data from Koynlabs API: " & e.msg)
        resp Http500, headers, responseContent & "event: error\ndata: {\"message\":\"Failed to fetch data from Koynlabs API: " & escapeJsonString(e.msg) & "\"}\n\n"
        return
      
      # Add status update
      responseContent.add("event: copilotStatusUpdate\ndata: {\"status\":\"Analyzing data with AI...\"}\n\n")
      
      # Process the data with OpenAI
      let processedChunks = await processWithOpenAI(query, koynData)
      
      # Add the processed response chunks
      for chunk in processedChunks:
        for c in chunk:
          responseContent.add("event: copilotMessageChunk\ndata: {\"delta\":\"" & escapeJsonString($c) & "\"}\n\n")
      
      # Add a final message about the source
      let finalMessage = "\n\nData sourced from Koynlabs API as of " & $now() & "."
      for c in finalMessage:
        responseContent.add("event: copilotMessageChunk\ndata: {\"delta\":\"" & escapeJsonString($c) & "\"}\n\n")
      
      # Send the complete response
      logDebug("Sending response with length: " & $responseContent.len)
      resp Http200, headers, responseContent 