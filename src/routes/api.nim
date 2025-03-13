# SPDX-License-Identifier: AGPL-3.0-only
import strutils, json
import jester

import router_utils
import "../types"

proc createApiRouter*(cfg: Config) =
  router api:
    get "/api/news":
      let source = @"source"
      # This is a simple example - you would replace this with actual data fetching
      let newsData = %* [
        {"title": "Bitcoin reaches new high", "url": "https://example.com/news/1"},
        {"title": "Ethereum 2.0 update", "url": "https://example.com/news/2"},
        {"title": "Solana ecosystem growing", "url": "https://example.com/news/3"}
      ]
      respJson newsData

    get "/api/data":
      # This is a simple example - you would replace this with actual data fetching
      let data = %* {
        "status": "success", 
        "data": {
          "bitcoin": {"price": 65000, "change": 2.5},
          "ethereum": {"price": 3200, "change": 1.8},
          "solana": {"price": 140, "change": 5.2}
        }
      }
      respJson data 