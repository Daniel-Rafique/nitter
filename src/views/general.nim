# SPDX-License-Identifier: AGPL-3.0-only
import uri, strutils, strformat
import karax/[karaxdsl, vdom]

import renderutils
import ../utils, ../types, ../prefs, ../formatters

import jester

const
  doctype = "<!DOCTYPE html>\n"
  lp = readFile("public/lp.svg")

proc toTheme(theme: string): string =
  theme.toLowerAscii.replace(" ", "_")

proc renderNavbar(cfg: Config; req: Request; rss, canonical: string): VNode =
  var path = req.params.getOrDefault("referer")
  if path.len == 0:
    path = $(parseUri(req.path) ? filterParams(req.params))
    if "/status/" in path: path.add "#m"

  buildHtml(nav):
    tdiv(class="inner-nav"):
      tdiv(class="nav-item"):
        a(class="site-name", href="/"): 
          img(class="koynlabs-logo", src="/logo.jpg", alt="Koynlabs Logo")
          text "Koynlabs"

      tdiv(class="nav-item right"):
        if cfg.enableRss and rss.len > 0:
          icon "rss-feed", title="RSS Feed", href=rss
        icon "bird", title="Open in XS", href=canonical
        a(href="https://liberapay.com/zedeus"): verbatim lp
        icon "info", title="About", href="/about"
        icon "cog", title="Preferences", href=("/settings?referer=" & encodeUrl(path))

proc renderTrendingTopics(): VNode =
  buildHtml(tdiv(class="trending-topics")):
    h3: text "Trending in Crypto"
    ul(class="topic-list"):
      li:
        a(href="/search?q=Bitcoin", class="trending-topic"):
          span(class="topic-name"): text "Bitcoin"
          span(class="topic-tag"): text "#BTC"
      li:
        a(href="/search?q=Ethereum", class="trending-topic"):
          span(class="topic-name"): text "Ethereum"
          span(class="topic-tag"): text "#ETH"
      li:
        a(href="/search?q=Solana", class="trending-topic"):
          span(class="topic-name"): text "Solana"
          span(class="topic-tag"): text "#SOL"
      li:
        a(href="/search?q=DeFi", class="trending-topic"):
          span(class="topic-name"): text "DeFi"
          span(class="topic-tag"): text "#DeFi"
      li:
        a(href="/search?q=NFT", class="trending-topic"):
          span(class="topic-name"): text "NFTs"
          span(class="topic-tag"): text "#NFT"
      li:
        a(href="/search?q=Web3", class="trending-topic"):
          span(class="topic-name"): text "Web3"
          span(class="topic-tag"): text "#Web3"

proc renderModernSearch(): VNode =
  buildHtml(tdiv(class="modern-search-container")):
    tdiv(class="modern-search-bar"):
      form(`method`="get", action="/search", autocomplete="off"):
        hiddenField("f", "tweets")
        input(`type`="text", name="q", autofocus="",
              placeholder="Search for posts, users, or topics...", dir="auto")
        button(`type`="submit", class="search-button"): 
          icon "search"
    
    renderTrendingTopics()

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
    link(rel="stylesheet", type="text/css", href="/css/modern.css?v=1")

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
        text titleText & " | " & cfg.title
      else:
        text "Koynlabs Twitter Search"

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

    # Meta tags for SEO
    meta(name="description", content="Search for crypto-related content with Koynlabs")
    meta(name="keywords", content="twitter, search, crypto, bitcoin, ethereum, solana, defi, koynlabs")

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
          # Only show the modern search on the homepage
          renderModernSearch()
        body

  result = doctype & $node

proc renderError*(error: string): VNode =
  buildHtml(tdiv(class="panel-container")):
    tdiv(class="error-panel"):
      span: verbatim error
