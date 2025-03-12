# SPDX-License-Identifier: AGPL-3.0-only
import uri, strutils, strformat
import karax/[karaxdsl, vdom]

# Import StyleAttr from karax/vstyles
import karax/vstyles

import renderutils
import ../utils, ../types, ../prefs, ../formatters

import jester

const
  doctype = "<!DOCTYPE html>\n"
  lp = readFile("public/lp.svg")

proc toTheme(theme: string): string =
  theme.toLowerAscii.replace(" ", "_")

proc aiSearchIcon(title: string, href: string): VNode =
  buildHtml(a(href=href, title=title, class="nav-item")):
    tdiv(class="icon-search-ai"):
      icon "search"
      span(class="ai-indicator"): text "AI"

proc renderNavbar(cfg: Config; req: Request; rss, canonical: string): VNode =
  var path = req.params.getOrDefault("referer")
  if path.len == 0:
    path = $(parseUri(req.path) ? filterParams(req.params))
    if "/status/" in path: path.add "#m"

  buildHtml(nav):
    tdiv(class="inner-nav"):
      tdiv(class="nav-item"):
        a(href="/"): 
          img(class="site-logo", src="/logo.jpg", alt="Koynlabs Logo")
        a(class="site-name", href="/"): text "Koynlabs"

      tdiv(class="nav-links"):
        a(href="/search?q=Bitcoin", class="nav-link"): text "Bitcoin"
        a(href="/search?q=Ethereum", class="nav-link"): text "Ethereum"
        a(href="/search?q=Solana", class="nav-link"): text "Solana"
        a(href="/search?q=DeFi", class="nav-link"): text "DeFi"

      tdiv(class="nav-item right"):
        aiSearchIcon("AI-Powered Search", "/search?ai=true")
        if cfg.enableRss and rss.len > 0:
          icon "rss-feed", title="RSS Feed", href=rss
        icon "info", title="About", href="/about"

proc renderTrendingTopics(): VNode =
  buildHtml(tdiv(class="trending-topics")):
    h3: text "Trending in Crypto"
    ul(class="topic-list"):
      li:
        a(href="/search?q=Bitcoin", class="trending-topic"): text "#Bitcoin"
      li:
        a(href="/search?q=Ethereum", class="trending-topic"): text "#Ethereum"
      li:
        a(href="/search?q=Solana", class="trending-topic"): text "#Solana"
      li:
        a(href="/search?q=DeFi", class="trending-topic"): text "#DeFi"
      li:
        a(href="/search?q=NFT", class="trending-topic"): text "#NFT"
      li:
        a(href="/search?q=Web3", class="trending-topic"): text "#Web3"

proc renderEnhancedSearch(): VNode =
  buildHtml(tdiv(class="enhanced-search-container")):
    h1(class="search-heading"): text "Discover Market Insights"
    p(class="search-subheading"): text "Real-time data for Bitcoin, Ethereum, Solana, and DeFi"
    
    form(`method`="get", action="/search", autocomplete="off", class="enhanced-search-form"):
      hiddenField("f", "tweets")
      input(`type`="text", name="q", autofocus="",
            placeholder="Search for insights...", dir="auto")
      button(`type`="submit", class="search-button"): 
        icon "search"
    
    # renderTrendingTopics()
    
    tdiv(class="powered-by"):
      text "Search Powered by "
      a(href="https://koyn.ai", target="_blank"): text "Koyn.ai"
    
    tdiv(class="openbb-badge"):
      text "Now compatible with "
      a(href="https://openbb.co/", target="_blank"):
        img(src="/logo.jpg", alt="OpenBB Logo", style = style(
          (StyleAttr.height, "20px"),
          (StyleAttr.width, "auto")
        ))
        text "OpenBB Workspace"
      
    p(class="openbb-info"):
      text "Add our custom copilot to OpenBB Workspace by using this URL: "
      code: text "https://koynlabs.com/copilots.json"

proc renderHead*(prefs: Prefs; cfg: Config; req: Request; titleText=""; desc="";
                 video=""; images: seq[string] = @[]; banner=""; ogTitle="";
                 rss=""; canonical=""): VNode =
  var theme = prefs.theme.toTheme
  if "theme" in req.params:
    theme = req.params["theme"].toTheme
    
  let ogType =
    if video.len > 0: "video"
    elif rss.len > 0: "object"
    elif images.len > 0: "photo"
    else: "article"

  let opensearchUrl = getUrlPrefix(cfg) & "/opensearch"

  buildHtml(head):
    link(rel="stylesheet", type="text/css", href="/css/style.css?v=19")
    link(rel="stylesheet", type="text/css", href="/css/fontello.css?v=2")
    link(rel="stylesheet", type="text/css", href="/css/koynlabs.css?v=1")

    if theme.len > 0:
      link(rel="stylesheet", type="text/css", href=(&"/css/themes/{theme}.css"))

    link(rel="apple-touch-icon", sizes="180x180", href="/apple-touch-icon.png")
    link(rel="icon", type="image/png", sizes="32x32", href="/favicon-32x32.png")
    link(rel="icon", type="image/png", sizes="16x16", href="/favicon-16x16.png")
    link(rel="manifest", href="/site.webmanifest")
    link(rel="mask-icon", href="/safari-pinned-tab.svg", color="#ff6c60")
    link(rel="search", type="application/opensearchdescription+xml", title=cfg.title,
                            href=opensearchUrl)

    if canonical.len > 0:
      link(rel="canonical", href=canonical)

    if cfg.enableRss and rss.len > 0:
      link(rel="alternate", type="application/rss+xml", href=rss, title="RSS feed")

    if prefs.hlsPlayback:
      script(src="/js/hls.min.js", `defer`="")
      script(src="/js/hlsPlayback.js", `defer`="")

    if prefs.infiniteScroll:
      script(src="/js/infiniteScroll.js", `defer`="")

    title:
      if titleText.len > 0:
        text titleText & " | Koynlabs"
      else:
        text "Koynlabs Market Insights"

    meta(name="viewport", content="width=device-width, initial-scale=1.0")
    meta(name="theme-color", content="#1F1F1F")
    meta(property="og:type", content=ogType)
    meta(property="og:title", content=(if ogTitle.len > 0: ogTitle else: titleText))
    meta(property="og:description", content=stripHtml(desc))
    meta(property="og:site_name", content="Koynlabs")
    meta(property="og:locale", content="en_US")

    if banner.len > 0 and not banner.startsWith('#'):
      let bannerUrl = getPicUrl(banner)
      link(rel="preload", type="image/png", href=bannerUrl, `as`="image")

    for url in images:
      let preloadUrl = if "400x400" in url: getPicUrl(url)
                       else: getSmallPic(url)
      link(rel="preload", type="image/png", href=preloadUrl, `as`="image")

      let image = getUrlPrefix(cfg) & getPicUrl(url)
      meta(property="og:image", content=image)
      meta(property="twitter:image:src", content=image)

      if rss.len > 0:
        meta(property="twitter:card", content="summary")
      else:
        meta(property="twitter:card", content="summary_large_image")

    if video.len > 0:
      meta(property="og:video:url", content=video)
      meta(property="og:video:secure_url", content=video)
      meta(property="og:video:type", content="text/html")

    # this is last so images are also preloaded
    # if this is done earlier, Chrome only preloads one image for some reason
    link(rel="preload", type="font/woff2", `as`="font",
         href="/fonts/fontello.woff2?21002321", crossorigin="anonymous")

proc renderMain*(body: VNode; req: Request; cfg: Config; prefs=defaultPrefs;
                 titleText=""; desc=""; ogTitle=""; rss=""; video="";
                 images: seq[string] = @[]; banner=""): string =

  let canonical = getTwitterLink(req.path, req.params)

  let node = buildHtml(html(lang="en")):
    renderHead(prefs, cfg, req, titleText, desc, video, images, banner, ogTitle,
               rss, canonical)

    body:
      renderNavbar(cfg, req, rss, canonical)

      tdiv(class="container"):
        if req.path == "/":
          # Only show the enhanced search on the homepage
          renderEnhancedSearch()
        if body != nil:
          body

  result = doctype & $node

proc renderError*(error: string): VNode =
  buildHtml(tdiv(class="panel-container")):
    tdiv(class="error-panel"):
      span: verbatim error
