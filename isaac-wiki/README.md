# 以撒 Wiki 离线阅读版

Windows 上双击 start.cmd，然后打开[本地 Wiki 首页](http://127.0.0.1:8765/)。电脑需要已有 Node.js。站点只在本机开放，保留首页、条目搜索、已归档的图片和音频，以及已编译的 Anm2 动画。

site/ 保存页面、素材、动画和只读索引。reader.mjs、offline.css、offline.js、wiki-player.js 用于阅读。移动或备份此文件夹时，请保留这些文件与 site/ 的相对位置。

下载器和构建工具保存在博客目录之外的 `isaac-wiki-tools/`。日常阅读只需此目录中的站点文件。

## GitHub Pages

[在线存档](https://1813644081.github.io/isaac-wiki/online/) 在浏览器中读取 `online/data/` 下的静态正文分包，图片和图标从 `online/media/` 加载。音频、动画及后台数据页面可通过原文链接访问。在线版与本机完整镜像使用各自的数据目录。
