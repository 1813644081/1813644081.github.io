const heading = document.querySelector("#heading");
const article = document.querySelector("#article");
const source = document.querySelector("#source");
const searchInput = document.querySelector("input[name=q]");
const params = new URLSearchParams(location.search);
const version = new URL(import.meta.url).search;
const origin = "https://isaac.huijiwiki.com";
const resultsPerPage = 100;

function titleLink(title) {
  return "./?title=" + encodeURIComponent(title);
}

function setHeading(title) {
  heading.textContent = title;
  document.title = title + " · 以撒 Wiki 在线存档";
  article.replaceChildren();
}

function paragraph(text) {
  const node = document.createElement("p");
  node.textContent = text;
  article.append(node);
  return node;
}

function link(text, href) {
  const node = document.createElement("a");
  node.textContent = text;
  node.href = href;
  return node;
}

async function readData(name) {
  const response = await fetch("./data/" + name + ".bin" + version);
  if (!response.ok || !response.body) throw new Error("存档 HTTP " + response.status);
  const json = response.body.pipeThrough(new DecompressionStream("gzip"));
  return new Response(json).json();
}

function renderSearch(titles) {
  const query = params.get("q").trim().slice(0, 200);
  searchInput.value = query;
  setHeading(query ? "搜索结果" : "全部条目");
  const needle = query.normalize("NFC").toLocaleLowerCase("zh-CN");
  const matched = Object.keys(titles).filter(title => title.toLocaleLowerCase("zh-CN").includes(needle));
  const pageCount = Math.max(1, Math.ceil(matched.length / resultsPerPage));
  const page = Math.min(pageCount, Math.max(1, parseInt(params.get("page"), 10) || 1));
  paragraph(query ? `“${query}”匹配 ${matched.length} 个条目。` : `共 ${matched.length} 个已存档条目。`);
  if (!matched.length) return;

  const list = document.createElement("ul");
  list.className = "results";
  const start = (page - 1) * resultsPerPage;
  for (const title of matched.slice(start, start + resultsPerPage)) {
    const item = document.createElement("li");
    item.append(link(title, titleLink(title)));
    list.append(item);
  }
  article.append(list);

  const pagination = document.createElement("nav");
  pagination.className = "pagination";
  pagination.setAttribute("aria-label", "结果分页");
  const searchPage = number => "./?" + new URLSearchParams({q: query, page: number});
  if (page > 1) pagination.append(link("上一页", searchPage(page - 1)));
  pagination.append(`第 ${page} / ${pageCount} 页`);
  if (page < pageCount) pagination.append(link("下一页", searchPage(page + 1)));
  article.append(pagination);
}

async function renderArticle(titles) {
  const title = (params.get("title") || "首页").normalize("NFC");
  const encoded = encodeURIComponent(title);
  const original = origin + "/wiki/" + encoded;
  source.append(
    link("原文及贡献者", original),
    link("编辑历史", origin + "/index.php?title=" + encoded + "&action=history"),
  );
  setHeading(title);
  if (!Object.hasOwn(titles, title)) {
    paragraph("此条目可在原站阅读。").append(" ", link("打开原文", original));
    return;
  }

  paragraph("正在读取条目…");
  const entries = await readData(titles[title]);
  if (!Object.hasOwn(entries, title)) throw new Error("存档条目缺失");
  article.innerHTML = entries[title];
  if (location.hash) {
    try {
      document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
    } catch {
      // A malformed fragment must not prevent reading the article.
    }
  }
}

try {
  const titles = await readData("titles");
  if (params.has("q")) renderSearch(titles);
  else await renderArticle(titles);
} catch (error) {
  console.error(error);
  setHeading("存档加载失败");
  paragraph("请刷新重试，或").append(link("前往原站", origin + "/wiki/"), "。");
}
