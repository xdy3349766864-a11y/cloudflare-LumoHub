// Cloudflare R2 图片管理系统 - 随机图片接口增强版 (修复语法错误)
export default {
  async fetch(request, env, ctx) {
    const sendJSON = (data, status = 200) => {
      return new Response(JSON.stringify(data), {
        status,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": env.CORS_ALLOW_ORIGIN || "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
          "X-Content-Type-Options": "nosniff",
          "X-XSS-Protection": "1; mode=block",
          "X-Frame-Options": "DENY"
        }
      });
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": env.CORS_ALLOW_ORIGIN || "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
          "Access-Control-Max-Age": "86400"
        }
      });
    }

    try {
      if (!env.MY_BUCKET) return sendJSON({ ok: false, msg: "存储桶未配置" }, 500);
      if (!env.R2_ADMIN_USER || !env.R2_ADMIN_PASS || !env.JWT_SECRET || !env.KV)
        return sendJSON({ ok: false, msg: "环境变量未配置" }, 500);

      const url = new URL(request.url);
      const path = url.pathname;

      const safeDecodeKey = (key) => {
        try {
          let k = decodeURIComponent(key);
          if (k.includes("../") || k.includes("..\\")) return "";
          k = k.replace(/\\/g, "/").replace(/\/+/g, "/");
          if (k.startsWith("/")) k = k.slice(1);
          const parts = k.split("/").filter(p => p && p !== "." && p !== "..");
          return parts.join("/").slice(0, 150);
        } catch {
          return "";
        }
      };

      // ====================== 增强版：随机图片接口 /random ======================
      if (path === "/random" && request.method === "GET") {
        // ---------------------- 限制 1: Referer 防盗链 ----------------------
        const referer = request.headers.get("Referer");
        const allowedReferers = env.ALLOWED_REFERERS ? env.ALLOWED_REFERERS.split(",").map(r => r.trim()) : [];
        
        if (allowedReferers.length > 0) {
          const isValidReferer = referer && allowedReferers.some(allowed => referer.startsWith(allowed));
          if (!isValidReferer && referer) {
            return new Response("🚫 未经授权的引用", { 
              status: 403, 
              headers: { "Content-Type": "text/plain; charset=utf-8" } 
            });
          }
        }

        // ---------------------- 限制 2: 访问频率限制 ----------------------
        const clientIP = request.headers.get("CF-Connecting-IP") || "unknown";
        const MAX_REQ = parseInt(env.RATE_LIMIT_MAX) || 20;
        const TIME_WINDOW = parseInt(env.RATE_LIMIT_WINDOW) || 60;
        const rateKey = `rate:random:${clientIP}`;
        
        const current = await env.KV.get(rateKey);
        const count = current ? parseInt(current) : 0;
        
        if (count >= MAX_REQ) {
          return new Response("⏳ 请求过于频繁，请喝杯茶休息一下", { 
            status: 429, 
            headers: { 
              "Content-Type": "text/plain; charset=utf-8",
              "Retry-After": TIME_WINDOW.toString()
            } 
          });
        }
        env.KV.put(rateKey, (count + 1).toString(), { expirationTtl: TIME_WINDOW }).catch(() => {});

        // ---------------------- 限制 3: 指定目录随机 ----------------------
        const targetDir = url.searchParams.get("dir");
        const format = url.searchParams.get("format")?.toLowerCase();

        // 递归获取所有文件
        let allObjects = [];
        let cursor = undefined;
        do {
          const listResult = await env.MY_BUCKET.list({ cursor, limit: 1000 });
          let filtered = listResult.objects;
          
          if (targetDir) {
            const dirPrefix = targetDir.endsWith("/") ? targetDir : `${targetDir}/`;
            filtered = filtered.filter(obj => obj.key.startsWith(dirPrefix));
          }
          
          filtered = filtered.filter(obj => /\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i.test(obj.key));
          
          allObjects = allObjects.concat(filtered);
          cursor = listResult.truncated ? listResult.cursor : undefined;
        } while (cursor);

        if (allObjects.length === 0) {
          return new Response("📭 这里还没有图片哦", { 
            status: 404, 
            headers: { "Content-Type": "text/plain; charset=utf-8" } 
          });
        }

        // 随机抽取
        const randomObject = allObjects[Math.floor(Math.random() * allObjects.length)];
        const imageObj = await env.MY_BUCKET.get(randomObject.key);

        if (!imageObj) {
          return new Response("😵 图片走丢了", { 
            status: 404, 
            headers: { "Content-Type": "text/plain; charset=utf-8" } 
          });
        }

        // 返回 JSON 格式
        if (format === "json") {
          return sendJSON({
            ok: true,
            url: `${url.origin}/${encodeURIComponent(randomObject.key)}`,
            name: randomObject.key,
            size: randomObject.size
          });
        }

        // 默认返回图片流
        return new Response(imageObj.body, {
          headers: {
            "Content-Type": imageObj.httpMetadata?.contentType || "image/webp",
            "Cache-Control": "public, max-age=60, no-cache",
            "Access-Control-Allow-Origin": "*",
            "X-Content-Type-Options": "nosniff"
          }
        });
      }

      if (path === "/") {
        return new Response(getFrontendHtml(), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "X-Frame-Options": "DENY"
          }
        });
      }

      if (request.method === "GET" && !["/login", "/list", "/delete", "/logout", "/random"].includes(path)) {
        const objectKey = safeDecodeKey(path.slice(1));
        if (!objectKey) return sendJSON({ ok: false, msg: "非法路径" }, 403);

        const obj = await env.MY_BUCKET.get(objectKey);
        if (!obj) return sendJSON({ ok: false, msg: "不存在" }, 404);

        return new Response(obj.body, {
          headers: {
            "Content-Type": obj.httpMetadata?.contentType || "image/webp",
            "Cache-Control": "public, max-age=604800",
            "Access-Control-Allow-Origin": "*",
            "X-Content-Type-Options": "nosniff"
          }
        });
      }

      if (path === "/login" && request.method === "POST") {
        const clientIP = request.headers.get("CF-Connecting-IP") || "unknown";
        const failKey = `login_fail:${clientIP}`;
        const failCount = parseInt(await env.KV.get(failKey) || "0");

        if (failCount >= 5) {
          return sendJSON({ ok: false, msg: "登录过于频繁，请10分钟后重试" }, 429);
        }

        const body = await request.json().catch(() => ({}));
        await new Promise(r => setTimeout(r, 300));
        
        if (body.user === env.R2_ADMIN_USER && body.pass === env.R2_ADMIN_PASS) {
          await env.KV.delete(failKey);
          const payload = {
            sub: "admin",
            jti: crypto.randomUUID(),
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 3600 * 24
          };
          const token = await signJWT(payload, env.JWT_SECRET);
          return sendJSON({ ok: true, token });
        } else {
          await env.KV.put(failKey, failCount + 1, { expirationTtl: 600 });
          return sendJSON({ ok: false, msg: "账号或密码错误" }, 401);
        }
      }

      if (path === "/logout" && request.method === "POST") {
        const token = request.headers.get("Authorization")?.replace("Bearer ", "") || "";
        if (token) {
          try {
            const payload = await verifyJWT(token, env.JWT_SECRET);
            const exp = payload.exp - Math.floor(Date.now() / 1000);
            if (exp > 0) await env.KV.put(`blacklist:${token}`, "1", { expirationTtl: exp });
          } catch {}
        }
        return sendJSON({ ok: true });
      }

      const token = request.headers.get("Authorization")?.replace("Bearer ", "") || "";
      let user = null;
      try {
        const isBlacklisted = await env.KV.get(`blacklist:${token}`);
        if (isBlacklisted) throw new Error("token已注销");
        const payload = await verifyJWT(token, env.JWT_SECRET);
        if (payload.sub === "admin") user = "admin";
      } catch {}
      if (!user) return sendJSON({ ok: false, msg: "未授权" }, 401);

      if (request.method === "PUT" && path !== "/") {
        const fileName = safeDecodeKey(path.slice(1));
        if (!fileName) return sendJSON({ ok: false, msg: "非法文件名" }, 403);
        const blob = await request.blob();
        
        await env.MY_BUCKET.put(fileName, blob, {
          httpMetadata: {
            contentType: request.headers.get("Content-Type") || "application/octet-stream",
            cacheControl: "public, max-age=604800"
          }
        });

        return sendJSON({ ok: true, url: `${url.origin}/${encodeURIComponent(fileName)}` });
      }

      if (path === "/list" && request.method === "GET") {
        const limit = Math.min(parseInt(url.searchParams.get("limit")) || 20, 100);
        const cursor = url.searchParams.get("cursor") || undefined;
        const sortBy = url.searchParams.get("sortBy") || "name";
        const order = url.searchParams.get("order") || "asc";
        
        const listResult = await env.MY_BUCKET.list({ limit, cursor });
        
        let sortedList = [...listResult.objects];
        sortedList.sort((a, b) => {
          let cmp = 0;
          if (sortBy === "name") cmp = a.key.localeCompare(b.key);
          if (sortBy === "size") cmp = a.size - b.size;
          if (sortBy === "time") {
            const timeA = a.key.match(/img_(\d+)_/)?.[1] || "0";
            const timeB = b.key.match(/img_(\d+)_/)?.[1] || "0";
            cmp = timeA.localeCompare(timeB);
          }
          return order === "asc" ? cmp : -cmp;
        });

        return sendJSON({
          ok: true,
          list: sortedList.map(o => ({
            name: o.key,
            url: `${url.origin}/${encodeURIComponent(o.key)}`,
            size: (o.size / 1024).toFixed(2) + "KB"
          })),
          hasMore: listResult.truncated,
          nextCursor: listResult.cursor
        });
      }

      if (path === "/delete" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const name = safeDecodeKey(body.name);
        if (!name) return sendJSON({ ok: false, msg: "非法参数" }, 403);
        await env.MY_BUCKET.delete(name);
        return sendJSON({ ok: true });
      }

      return sendJSON({ ok: false, msg: "接口不存在" }, 404);

    } catch (err) {
      console.error(err);
      return sendJSON({ ok: false, msg: "服务器异常" }, 500);
    }
  }
};

async function signJWT(payload, secret) {
  const enc = s => btoa(JSON.stringify(s)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const h = enc({ alg: "HS256", typ: "JWT" });
  const p = enc(payload);
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${h}.${p}`));
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${h}.${p}.${sig}`;
}

async function verifyJWT(token, secret) {
  const [h, p, sig] = token.split(".");
  if (!h || !p || !sig) throw new Error("无效Token");
  const dec = s => atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const payload = JSON.parse(dec(p));
  if (payload.exp < Math.floor(Date.now() / 1000)) throw new Error("Token已过期");
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
  );
  const sigBuf = Uint8Array.from(dec(sig), c => c.charCodeAt(0));
  const ok = await crypto.subtle.verify("HMAC", key, sigBuf, new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new Error("Token验证失败");
  return payload;
}

function getFrontendHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>图片存储器</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Noto+Sans+SC:wght@400;500&display=swap');
    :root { --tw-color-primary: #165DFF; }
    * {
      transition-property: color, background-color, border-color, text-decoration-color, fill, stroke, transform;
      transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
      transition-duration: 150ms;
    }
    body { font-family: 'Inter', 'Noto Sans SC', sans-serif; }
    .card { box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.05); }
    .img-thumbnail { transition: transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275), opacity 0.5s ease; }
    .img-item:hover .img-thumbnail { transform: scale(1.08); }
    .tab-item.active { color: #165DFF; border-bottom-color: #165DFF; }
    .shimmer {
      background: linear-gradient(90deg, #f3f4f6 25%, #f9fafb 50%, #f3f4f6 75%);
      background-size: 200% 100%; animation: shimmer-ani 1.5s infinite linear;
    }
    @keyframes shimmer-ani { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    .no-scrollbar::-webkit-scrollbar { display: none; }
    .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    .animate-fade-in { animation: fadeIn 0.4s ease-out forwards; }
  </style>
</head>
<body class="bg-gray-50 min-h-screen text-gray-900">
  <div id="loginContainer" class="min-h-screen flex items-center justify-center p-4">
    <div class="card max-w-md w-full bg-white rounded-3xl shadow-xl overflow-hidden animate-fade-in">
      <div class="px-8 pt-10 pb-8">
        <div class="flex justify-center mb-6">
          <div class="w-16 h-16 bg-blue-50 rounded-2xl flex items-center justify-center text-4xl">📸</div>
        </div>
        <h1 class="text-3xl font-semibold text-center text-gray-900 mb-1">图片存储器</h1>
        <p class="text-center text-gray-500 mb-8 text-sm">Cloudflare R2 · WebP 智能压缩</p>
        <div class="space-y-4">
          <div>
            <label class="block text-xs font-semibold text-gray-400 uppercase mb-1 ml-1">用户名</label>
            <input id="user" type="text" placeholder="Admin" class="w-full px-5 py-3.5 bg-gray-50 border border-gray-200 focus:border-blue-500 rounded-2xl outline-none">
          </div>
          <div>
            <label class="block text-xs font-semibold text-gray-400 uppercase mb-1 ml-1">密码</label>
            <input id="pass" type="password" placeholder="••••••••" class="w-full px-5 py-3.5 bg-gray-50 border border-gray-200 focus:border-blue-500 rounded-2xl outline-none">
          </div>
          <button id="loginBtn" class="w-full py-4 bg-[#165DFF] hover:bg-blue-600 text-white font-medium text-lg rounded-2xl shadow-lg shadow-blue-500/20 active:scale-[0.98]">
            <span>立即登录</span>
          </button>
          <div id="loginMsg" class="text-center min-h-[24px] text-sm font-medium"></div>
        </div>
      </div>
    </div>
  </div>

  <div id="mainContainer" class="hidden min-h-screen flex flex-col">
    <header class="bg-white/80 backdrop-blur-md border-b sticky top-0 z-50">
      <div class="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 bg-blue-600 text-white rounded-xl flex items-center justify-center text-xl">📸</div>
          <div class="hidden sm:block">
            <h1 class="text-xl font-bold text-gray-900">R2 Storage</h1>
            <p class="text-[10px] text-gray-400 uppercase tracking-widest mt-1">Professional Cloud Storage</p>
          </div>
        </div>
        <button onclick="logout()" class="flex items-center gap-2 px-4 py-2 hover:bg-red-50 rounded-xl text-sm font-medium text-gray-600 hover:text-red-600">
          <span>退出</span>
        </button>
      </div>
      <div class="max-w-7xl mx-auto px-6">
        <div class="flex gap-8">
          <button onclick="switchTab(0)" id="tabUpload" class="tab-item px-2 py-4 text-sm font-semibold cursor-pointer border-b-2 active">上传图片</button>
          <button onclick="switchTab(1)" id="tabImages" class="tab-item px-2 py-4 text-sm font-semibold cursor-pointer border-b-2">全部图片</button>
        </div>
      </div>
    </header>

    <main class="max-w-7xl mx-auto px-6 py-8 w-full flex-grow">
      <div id="uploadTab" class="tab-content animate-fade-in">
        <div class="grid grid-cols-1 lg:grid-cols-12 gap-8">
          <div class="lg:col-span-7">
            <div id="uploadArea" onclick="document.getElementById('fileInput').click()"
                 class="group bg-white border-2 border-dashed border-gray-200 hover:border-blue-400 hover:bg-blue-50/30 rounded-3xl p-12 text-center cursor-pointer flex flex-col items-center justify-center min-h-[400px]">
              <div class="w-20 h-20 bg-blue-50 text-blue-500 rounded-3xl flex items-center justify-center text-4xl mb-6">📤</div>
              <h3 class="text-2xl font-bold text-gray-800 mb-2">点击或拖拽图片</h3>
              <p class="text-gray-400 text-sm mb-8">支持 JPG, PNG, GIF, WebP 自动压缩</p>
              <input type="file" id="fileInput" accept="image/*" multiple class="hidden" onchange="handleFileSelect(this.files)">
              <div class="flex items-center gap-2 bg-white border px-4 py-2 rounded-2xl text-xs font-bold">
                <span>压缩质量:</span>
                <span id="qualityDisplayMini" class="text-blue-600">80%</span>
              </div>
            </div>
          </div>
          <div class="lg:col-span-5 space-y-6">
            <div class="card bg-white rounded-3xl p-6">
              <div class="flex items-center justify-between mb-6">
                <span class="font-bold text-gray-700">WebP 压缩算法</span>
                <select id="webpQualitySelect" onchange="updateQualityDisplay()" 
                        class="bg-gray-50 rounded-xl px-3 py-2 text-sm border border-gray-100">
                  <option value="0.5">极速压缩 (50%)</option>
                  <option value="0.7">平衡模式 (70%)</option>
                  <option value="0.8" selected>标准推荐 (80%)</option>
                  <option value="0.9">高保真度 (90%)</option>
                  <option value="1.0">无损画质 (100%)</option>
                </select>
              </div>
              <div class="h-1.5 bg-gray-100 rounded-full"><div id="qualityBar" class="h-full bg-blue-500 w-[80%]"></div></div>
            </div>
          </div>
        </div>
        <div class="mt-12"><h3 class="text-lg font-bold mb-6">当前上传队列</h3><div id="uploadRecordsList" class="grid grid-cols-1 md:grid-cols-2 gap-4"></div></div>
      </div>
      
      <div id="imagesTab" class="tab-content hidden animate-fade-in">
        <div class="flex flex-col md:flex-row justify-between gap-4 mb-8">
          <h3 class="text-2xl font-bold">图库资源 <span id="imageCountBadge" class="text-xs bg-blue-50 text-blue-600 px-2 py-1 rounded-lg">0 ITEMS</span></h3>
          <div class="flex gap-2">
            <select id="sortSelect" onchange="changeSort()" class="px-3 py-2 border rounded-xl text-sm">
              <option value="name_asc">按名称 ↑</option>
              <option value="name_desc">按名称 ↓</option>
              <option value="size_asc">按大小 ↑</option>
              <option value="size_desc">按大小 ↓</option>
              <option value="time_asc">按时间 ↑</option>
              <option value="time_desc">按时间 ↓</option>
            </select>
            <button onclick="toggleImagesList()" id="toggleBtn" class="px-5 py-2.5 bg-gray-900 text-white rounded-xl text-xs">展开全部</button>
          </div>
        </div>
        <div id="imagesList" class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4"></div>
        <div class="mt-12 flex justify-center gap-6">
          <button onclick="loadPrevPage()" id="prevPageBtn" class="px-6 py-3 bg-white border rounded-2xl text-sm font-bold">← 上一页</button>
          <button onclick="loadNextPage()" id="nextPageBtn" class="px-6 py-3 bg-white border rounded-2xl text-sm font-bold">下一页 →</button>
        </div>
      </div>
    </main>
  </div>

  <div id="toast" class="hidden fixed bottom-8 left-1/2 -translate-x-1/2 bg-gray-900/95 text-white px-8 py-4 rounded-2xl z-50"></div>

  <script>
    let token = localStorage.getItem("r2_token") || "";
    let uploadRecords = [];
    let imagesListExpanded = false;
    let currentWebpQuality = 0.8;
    let paginationState = { currentPage:1, pageSize:20, nextCursor:null, prevCursors:[], hasMore:false };
    let sortState = { sortBy: "name", order: "asc" };

    function showToast(m,t="success"){
      const e=document.getElementById("toast");
      e.innerHTML=(t=="success"?"✅":"❌")+" "+m;
      e.classList.remove("hidden");
      setTimeout(()=>e.classList.add("hidden"),3000);
    }

    function switchTab(i){
      document.querySelectorAll(".tab-content").forEach(e=>e.classList.add("hidden"));
      document.querySelectorAll(".tab-item").forEach(e=>e.classList.remove("active"));
      i===0?(document.getElementById("uploadTab").classList.remove("hidden"),document.getElementById("tabUpload").classList.add("active"))
      :(document.getElementById("imagesTab").classList.remove("hidden"),document.getElementById("tabImages").classList.add("active"),loadImageList());
    }

    function updateQualityDisplay(){
      const v=parseFloat(document.getElementById("webpQualitySelect").value);
      currentWebpQuality=v;
      const p=Math.round(v*100);
      document.getElementById("qualityDisplayMini").textContent=p+"%";
      document.getElementById("qualityBar").style.width=p+"%";
    }

    function changeSort(){
      const val = document.getElementById("sortSelect").value.split("_");
      sortState.sortBy = val[0];
      sortState.order = val[1];
      paginationState.prevCursors = [];
      paginationState.nextCursor = null;
      paginationState.currentPage = 1;
      loadImageList();
    }

    async function doLogin(){
      const u=document.getElementById("user").value.trim();
      const p=document.getElementById("pass").value.trim();
      const m=document.getElementById("loginMsg");
      if(!u||!p){
        m.innerHTML="<span class='text-red-500'>请填写完整信息</span>";
        return;
      }
      try{
        const r=await fetch("/login",{
          method:"POST",
          headers:{"Content-Type":"application/json"},
          body:JSON.stringify({user:u,pass:p})
        });
        const d=await r.json();
        if(d.ok){
          token=d.token;
          localStorage.setItem("r2_token",token);
          initApp();
        }else{
          m.innerHTML="<span class='text-red-500'>"+d.msg+"</span>";
        }
      }catch(e){
        showToast("网络异常，请重试","error");
        console.error(e);
      }
    }

    async function logout(){
      if(!confirm("确定退出？"))return;
      await fetch("/logout",{method:"POST",headers:{"Authorization":"Bearer "+token}});
      localStorage.removeItem("r2_token");
      location.reload();
    }

    function getBeijingTimeString(){
      const d=new Date();
      return d.toISOString().slice(0,19).replace(/\\D/g,"");
    }

    async function compressImage(file){
      return new Promise((res,rej)=>{
        const img=new Image();
        img.src=URL.createObjectURL(file);
        img.onload=()=>{
          try{
            const canvas=document.createElement("canvas");
            const max=2000;
            let w=img.width,h=img.height;
            if(w>max){h=h*(max/w);w=max;}
            if(h>max){w=w*(max/h);h=max;}
            canvas.width=w;canvas.height=h;
            const ctx=canvas.getContext("2d");
            ctx.drawImage(img,0,0,w,h);
            canvas.toBlob(b=>b?res(b):rej(new Error("压缩失败")),"image/webp",currentWebpQuality);
          }catch(e){rej(e);}
        };
        img.onerror=()=>rej(new Error("图片损坏"));
      });
    }

    async function handleFileSelect(files){
      if(!token)return showToast("请登录","error");
      for(const f of files){
        if(!f.type.startsWith("image/"))continue;
        const id=Math.random().toString(36).slice(2,10);
        uploadRecords.unshift({id,name:f.name,progress:0,status:"处理中...",url:""});
        renderUploadRecords();
        try{
          const blob=await compressImage(f);
          await uploadToR2(blob,id,f.name);
        }catch(e){
          uploadRecords.find(i=>i.id===id).status="失败："+e.message;
          renderUploadRecords();
        }
      }
    }

    async function uploadToR2(blob,id,name){
      const time=getBeijingTimeString();
      const rand=Math.floor(Math.random()*10000).toString().padStart(4,"0");
      const fn="img_"+time+"_"+rand+".webp";
      const xhr=new XMLHttpRequest();
      xhr.open("PUT","/"+fn,true);
      xhr.setRequestHeader("Authorization","Bearer "+token);
      xhr.upload.onprogress=e=>{
        if(e.lengthComputable){
          const p=Math.round(e.loaded/e.total*100);
          const r=uploadRecords.find(i=>i.id===id);
          r.progress=p;
          r.status=p<100?"上传中...":"处理中...";
          renderUploadRecords();
        }
      };
      xhr.onload=()=>{
        if(xhr.status===200){
          const d=JSON.parse(xhr.responseText);
          const r=uploadRecords.find(i=>i.id===id);
          r.progress=100;r.status="成功";r.url=d.url;
          renderUploadRecords();
          showToast("上传成功");
        }else showToast("上传失败","error");
      };
      xhr.send(blob);
    }

    function renderUploadRecords(){
      const c=document.getElementById("uploadRecordsList");
      c.innerHTML=uploadRecords.map(r=>
        '<div class="bg-white border rounded-2xl p-4 flex gap-4">'+
          '<div class="flex-1">'+
            '<div class="flex justify-between text-xs mb-1">'+
              '<span>'+r.name+'</span><span>'+r.progress+'%</span>'+
            '</div>'+
            '<div class="h-1 bg-gray-100"><div class="h-full bg-blue-500" style="width:'+r.progress+'%"></div></div>'+
            '<div class="text-xs mt-1 text-gray-500">'+r.status+'</div>'+
          '</div>'+
          (r.url?'<button onclick="copy(&#39;'+r.url+'&#39;)" class="p-2 bg-blue-50 text-blue-600 rounded-xl">复制</button>':'')+
        '</div>'
      ).join("");
    }

    async function loadImageList(cursor=null){
      const c=document.getElementById("imagesList");
      c.innerHTML=Array(12).fill(0).map(()=>'<div class="aspect-square rounded-2xl shimmer"></div>').join("");
      try{
        let u="/list?limit="+paginationState.pageSize+"&sortBy="+sortState.sortBy+"&order="+sortState.order;
        if(cursor)u+="&cursor="+encodeURIComponent(cursor);
        const r=await fetch(u,{headers:{"Authorization":"Bearer "+token}});
        const d=await r.json();
        c.innerHTML=d.list.map(i=>
          '<div class="bg-white rounded-3xl overflow-hidden border hover:shadow-lg">'+
            '<div class="aspect-square relative">'+
              '<div class="absolute inset-0 shimmer"></div>'+
              '<img src="'+i.url+'" loading="lazy" class="w-full h-full object-cover opacity-0" onload="this.style.opacity=1;this.previousElementSibling.remove()">'+
              '<div class="absolute inset-0 bg-black/40 opacity-0 hover:opacity-100 flex items-center justify-center gap-2">'+
                '<button onclick="copy(&#39;'+i.url+'&#39;)" class="w-8 h-8 bg-white rounded-full flex items-center justify-center">🔗</button>'+
                '<button onclick="del(&#39;'+i.name+'&#39;)" class="w-8 h-8 bg-white text-red-500 rounded-full flex items-center justify-center">🗑️</button>'+
              '</div>'+
            '</div>'+
            '<div class="p-3 text-xs font-bold text-gray-700 truncate">'+i.name+'</div>'+
          '</div>'
        ).join("");
        paginationState.hasMore=d.hasMore;
        paginationState.nextCursor=d.nextCursor;
        document.getElementById("imageCountBadge").textContent=d.list.length+" ITEMS";
      }catch(e){showToast("加载失败","error")}
    }

    function toggleImagesList(){
      imagesListExpanded=!imagesListExpanded;
      paginationState.pageSize=imagesListExpanded?100:20;
      document.getElementById("toggleBtn").textContent=imagesListExpanded?"收起列表":"展开全部";
      loadImageList();
    }

    function loadNextPage(){
      if(paginationState.hasMore && paginationState.nextCursor){
        paginationState.prevCursors.push(paginationState.nextCursor);
        paginationState.currentPage++;
        loadImageList(paginationState.nextCursor);
      }
    }

    function loadPrevPage(){
      if(paginationState.currentPage>1){
        paginationState.currentPage--;
        const cursor = paginationState.prevCursors.pop() || null;
        loadImageList(cursor);
      }
    }

    async function del(n){
      if(!confirm("确定删除？"))return;
      const r=await fetch("/delete",{method:"POST",headers:{"Authorization":"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify({name:n})});
      const d=await r.json();
      d.ok?showToast("删除成功"):showToast("失败","error");
      loadImageList();
    }

    async function copy(t){
      await navigator.clipboard.writeText(t);
      showToast("链接已复制");
    }

    function initApp(){
      document.getElementById("loginContainer").classList.add("hidden");
      document.getElementById("mainContainer").classList.remove("hidden");
      switchTab(0);
    }

    document.addEventListener("DOMContentLoaded",()=>{
      document.getElementById("loginBtn").addEventListener("click", doLogin);
      if(token) initApp();
      updateQualityDisplay();
    });
  </script>
</body>
</html>`;
}
