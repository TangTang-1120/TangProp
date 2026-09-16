
// ============================================================
// TangProp — Frontend Logic
// ============================================================

// 子路径部署（/tangprop/）时修正静态资源路径
(function setupAssetBase() {
  if (location.protocol === 'file:') return;
  const m = location.pathname.match(/^(.*\/tangprop\/)/);
  if (m) {
    const base = document.createElement('base');
    base.href = m[1];
    document.head.prepend(base);
  }
})();

// 自动检测 API 地址
let API;
if (location.protocol === 'file:') {
  API = 'http://localhost:8080';
} else if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
  API = location.port === '8080' ? '' : 'http://localhost:8080';
} else {
  // 腾讯云 / 域名部署：走同源，由 Nginx 反代 /chat、/auth 等
  API = '';
}

// 统一 fetch 封装：网络错误时给友好提示
async function apiFetch(url, options = {}) {
  try {
    const res = await fetch(url, options);
    return res;
  } catch (e) {
    if (e instanceof TypeError && e.message.includes('Failed to fetch')) {
      throw new Error('无法连接服务器，请检查网络或刷新页面重试');
    }
    throw e;
  }
}

function apiErrorDetail(data, fallback = '请求失败') {
  const d = data?.detail;
  if (!d) return data?.error || data?.message || fallback;
  if (typeof d === 'string') return d;
  if (Array.isArray(d)) {
    return d.map(item => item.msg || item.message || JSON.stringify(item)).join('；');
  }
  return String(d);
}
const USER_ID = '18400115020';

let currentUser = null;
let chatHintDefaultParent = null;

const MODEL_META = {
  'doubao-seed-2-1-turbo-260628': { new: true, desc: '豆包 Seed 2.1 Turbo · 极速免费', rate: 0.00, tag: '推荐' },
  'doubao-seed-2-1-pro-260628': { new: true, desc: '豆包 Seed 2.1 Pro · 更强推理', rate: 0.00, tag: '新' },
  'Qwen/Qwen2.5-7B-Instruct': { new: false, desc: '硅基免费 · 轻量快速', rate: 0.00, tag: '免费' },
  'THUDM/glm-4-9b-chat': { new: false, desc: '硅基免费 · GLM 9B', rate: 0.00, tag: '免费' },
  'glm-5.2': { new: true, desc: '智谱旗舰 · GLM-5.2 长上下文/强推理', rate: null, tag: '旗舰' },
  'glm-5.2[1m]': { new: true, desc: '智谱旗舰 · GLM-5.2 百万上下文', rate: null, tag: '1M' },
  'glm-4-flash': { new: false, desc: '智谱免费 · 闪电版', rate: 0.00, tag: '免费' },
  'glm-4v-flash': { new: true, desc: '智谱免费 · 看图理解', rate: 0.00, tag: '看图' },
};

const PROVIDER_LOGOS = {
  deepseek: (bg) => `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><rect width="32" height="32" rx="8" fill="${bg || '#fff'}" stroke="#e8e8e8" stroke-width="0.5"/><g transform="translate(4,4) scale(1)"><path d="M19.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C-.918 8.606-1.231 10.684-.848 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM7.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614z" fill="#4D6BFE" transform="translate(-0.5,-1.5)"/></g></svg>`,

  siliconflow: (bg) => `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><rect width="32" height="32" rx="8" fill="${bg || '#fff'}" stroke="#e8e8e8" stroke-width="0.5"/><g transform="translate(4,4)"><path clip-rule="evenodd" d="M22.956 6.521H12.522c-.577 0-1.044.468-1.044 1.044v3.13c0 .577-.466 1.044-1.043 1.044H1.044c-.577 0-1.044.467-1.044 1.044v4.174C0 17.533.467 18 1.044 18h10.434c.577 0 1.044-.467 1.044-1.043v-3.13c0-.578.466-1.044 1.043-1.044h9.391c.577 0 1.044-.467 1.044-1.044V7.565c0-.576-.467-1.044-1.044-1.044z" fill="#6E29F6" fill-rule="evenodd"/></g></svg>`,

  zhipu: (bg) => `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><rect width="32" height="32" rx="8" fill="${bg || '#fff'}" stroke="#e8e8e8" stroke-width="0.5"/><g transform="translate(4,4)"><defs><linearGradient id="zhipu-grad" x1="-18.756%" x2="70.894%" y1="49.371%" y2="90.944%"><stop offset="0%" stop-color="#504AF4"/><stop offset="100%" stop-color="#3485FF"/></linearGradient></defs><path d="M9.917 2c4.906 0 10.178 3.947 8.93 10.58-.014.07-.037.14-.057.21l-.003-.277c-.083-3-1.534-8.934-8.87-8.934-3.393 0-8.137 3.054-7.93 8.158-.04 4.778 3.555 8.4 7.95 8.332l.073-.001c1.2-.033 2.763-.429 3.1-1.657.063-.031.26.534.268.598.048.256.112.369.192.34.981-.348 2.286-1.222 1.952-2.38-.176-.61-1.775-.147-1.921-.347.418-.979 2.234-.926 3.153-.716.443.102.657.38 1.012.442.29.052.981-.2.96.242-1.5 3.042-4.893 5.41-8.808 5.41C3.654 22 0 16.574 0 11.737 0 5.947 4.959 2 9.917 2zM9.9 5.3c.484 0 1.125.225 1.38.585 3.669.145 4.313 2.686 4.694 5.444.255 1.838.315 2.3.182 1.387l.083.59c.068.448.554.737.982.516.144-.075.254-.231.328-.47a.2.2 0 01.258-.13l.625.22a.2.2 0 01.124.238 2.172 2.172 0 01-.51.92c-.878.917-2.757.664-3.08-.62-.14-.554-.055-.626-.345-1.242-.292-.621-1.238-.709-1.69-.295-.345.315-.407.805-.406 1.282L12.6 15.9a.9.9 0 01-.9.9h-1.4a.9.9 0 01-.9-.9v-.65a1.15 1.15 0 10-2.3 0v.65a.9.9 0 01-.9.9H4.8a.9.9 0 01-.9-.9l.035-3.239c.012-1.884.356-3.658 2.47-4.134.2-.045.252.13.29.342.025.154.043.252.053.294.701 3.058 1.75 4.299 3.144 3.722l.66-.331.254-.13c.158-.082.25-.131.276-.15.012-.01-.165-.206-.407-.464l-1.012-1.067a8.925 8.925 0 01-.199-.216c-.047-.034-.116.068-.208.306-.074.157-.251.252-.272.326-.013.058.108.298.362.72.164.288.22.508-.31.343-1.04-.8-1.518-2.273-1.684-3.725-.004-.035-.162-1.913-.162-1.913a1.2 1.2 0 011.113-1.281L9.9 5.3z" fill="url(#zhipu-grad)" fill-rule="evenodd"/></g></svg>`,

  bailian: (bg) => `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><rect width="32" height="32" rx="8" fill="${bg || '#fff'}" stroke="#e8e8e8" stroke-width="0.5"/><g transform="translate(4,4)"><path d="M6.336 8.919v6.162l5.335-3.083L6.337 8.92z" fill="#1C54E3"/><path d="M21.394 5.288s-.006-.006-.01-.006L17.01 2.754 6.336 8.92l5.335 3.082 9.701-5.6.016-.01a.635.635 0 00.006-1.1v-.003z" fill="#AA9AFF"/><path d="M21.71 12.465a.62.62 0 00-.316.085s-.006 0-.009.003l-4.375 2.528 5.05 2.915h.006a2.06 2.06 0 00.28-1.04v-3.855a.637.637 0 00-.636-.636z" fill="#00EAD1"/><path d="M22.06 17.996l-5.05-2.915L6.34 21.242l4.27 2.465s.016.006.022.012a2.102 2.102 0 002.093 0c.006-.003.016-.006.022-.012l8.538-4.93c.003 0 .006-.003.01-.006.321-.183.589-.45.775-.772h-.006l-.004-.003z" fill="#00CEC9"/><path d="M11.672 11.998l-5.336 3.083-1.444.832-3.605 2.083H1.28c.173.303.416.555.709.738l.078.044.016.01.02.012 4.232 2.442 10.671-6.161-5.335-3.082z" fill="#00EAD1"/><path d="M12.74.29c-.1-.06-.208-.107-.315-.148-.02-.006-.038-.016-.057-.022a2.121 2.121 0 00-.7-.12c-.233 0-.457.038-.668.11l-.031.01a2.196 2.196 0 00-.372.17L2.068 5.222s-.003 0-.006.003c-.324.183-.592.451-.781.773h.006l5.049 2.918L17.01 2.758 12.74.29z" fill="#7347FF"/><path d="M1.287 6.001H1.28A2.06 2.06 0 001 7.041v9.915c0 .378.1.735.28 1.043h.007l5.049-2.918V8.919l-5.05-2.918z" fill="#0423DA"/></g></svg>`,

  volcengine: (bg) => `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><rect width="32" height="32" rx="8" fill="${bg || '#fff'}" stroke="#e8e8e8" stroke-width="0.5"/><g transform="translate(4,4)"><path d="M19.44 10.153l-2.936 11.586a.215.215 0 00.214.261h5.87a.215.215 0 00.214-.261l-2.95-11.586a.214.214 0 00-.412 0zM3.28 12.778l-2.275 8.96A.214.214 0 001.22 22h4.532a.212.212 0 00.214-.165.214.214 0 000-.097l-2.276-8.96a.214.214 0 00-.41 0z" fill="#00E5E5"/><path d="M7.29 5.359L3.148 21.738a.215.215 0 00.203.261h8.29a.214.214 0 00.215-.261L7.7 5.358a.214.214 0 00-.41 0z" fill="#006EFF"/><path d="M14.44.15a.214.214 0 00-.41 0L8.366 21.739a.214.214 0 00.214.261H19.9a.216.216 0 00.171-.078.214.214 0 00.044-.183L14.439.15z" fill="#006EFF"/><path d="M10.278 7.741L6.685 21.736a.214.214 0 00.214.264h7.17a.215.215 0 00.214-.264L10.688 7.741a.214.214 0 00-.41 0z" fill="#00E5E5"/></g></svg>`,

  groq: (bg) => `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><rect width="32" height="32" rx="8" fill="${bg || '#f59e0b'}"/><g transform="translate(4,4)"><path d="M12.036 2c-3.853-.035-7 3-7.036 6.781-.035 3.782 3.055 6.872 6.908 6.907h2.42v-2.566h-2.292c-2.407.028-4.38-1.866-4.408-4.23-.029-2.362 1.901-4.298 4.308-4.326h.1c2.407 0 4.358 1.915 4.365 4.278v6.305c0 2.342-1.944 4.25-4.323 4.279a4.375 4.375 0 01-3.033-1.252l-1.851 1.818A7 7 0 0012.029 22h.092c3.803-.056 6.858-3.083 6.879-6.816v-6.5C18.907 4.963 15.817 2 12.036 2z" fill="#fff"/></g></svg>`,

  openai: (bg) => `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><rect width="32" height="32" rx="8" fill="${bg || '#000'}"/><g transform="translate(4,4)"><path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z" fill="#fff"/></g></svg>`,

  anthropic: (bg) => `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><rect width="32" height="32" rx="8" fill="${bg || '#d97757'}"/><g transform="translate(4,4)"><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" fill="#fff" fill-rule="nonzero"/></g></svg>`,

  hunyuan: (bg) => `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><rect width="32" height="32" rx="8" fill="${bg || '#0055E9'}"/><g transform="translate(4,4)"><circle cx="12" cy="12" fill="#0055E9" r="12"/><path d="M12 0c.518 0 1.028.033 1.528.096A6.188 6.188 0 0112.12 12.28l-.12.001c-2.99 0-5.242 2.179-5.554 5.11-.223 2.086.353 4.412 2.242 6.146C3.672 22.1 0 17.479 0 12 0 5.373 5.373 0 12 0z" fill="#A8DFF5"/><path d="M5.286 5a2.438 2.438 0 01.682 3.38c-3.962 5.966-3.215 10.743 2.648 15.136C3.636 22.056 0 17.452 0 12c0-1.787.39-3.482 1.09-5.006.253-.435.525-.872.817-1.311A2.438 2.438 0 015.286 5z" fill="#0055E9"/><path d="M12.98.04c.272.021.543.053.81.093.583.106 1.117.254 1.538.44 6.638 2.927 8.07 10.052 1.748 15.642a4.125 4.125 0 01-5.822-.358c-1.51-1.706-1.3-4.184.357-5.822.858-.848 3.108-1.223 4.045-2.441 1.257-1.634 2.122-6.009-2.523-7.506L12.98.039z" fill="#00BCFF"/><path d="M13.528.096A6.187 6.187 0 0112 12.281a5.75 5.75 0 00-1.71.255c.147-.905.595-1.784 1.321-2.501.858-.848 3.108-1.223 4.045-2.441 1.27-1.651 2.14-6.104-2.676-7.554.184.014.367.033.548.056z" fill="#ECECEE"/></g></svg>`,
};

function getProviderLogo(providerId, available=true) {
  const fn = PROVIDER_LOGOS[providerId] || PROVIDER_LOGOS.hunyuan;
  return fn(); // 不可用状态由 CSS filter grayscale 处理
}

function autoIcon() {
  return `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><rect width="32" height="32" rx="8" fill="url(#auto-grad)"/><defs><linearGradient id="auto-grad" x1="0" y1="0" x2="32" y2="32"><stop offset="0%" stop-color="#52B6FB"/><stop offset="100%" stop-color="#FF70A3"/></linearGradient></defs><circle cx="11" cy="14" r="3" fill="#fff" opacity="0.6"/><circle cx="21" cy="14" r="3" fill="#fff" opacity="0.9"/><circle cx="16" cy="21" r="3" fill="#fff" opacity="0.75"/></svg>`;
}

let state = {
  providers: [],
  selectedProvider: null,
  selectedModel: null,
  autoMode: true,
  autoPrediction: null,
  maxMode: false,
  conversations: [],
  activeConv: 'default',
  loading: false,
  inChat: false,
  activeScene: null,
  pendingImages: [],
  draftAgent: false,
  pendingExpert: null,
  imageModel: localStorage.getItem('tangprop-image-model') || 'doubao:seedream-4',
  imageModels: [],
  workspace: 'default',
  agentPermission: 'default',
  thinkingLevel: 'medium',
  modelDropdownAnchor: null,
  commandPaletteInput: null,
  forwardMessageText: null,
};

// ── Conversation Persistence ──
const CONV_STORAGE_KEY = 'tangprop-conversations';
const IMAGE_MODEL_KEY = 'tangprop-image-model';

function saveConversations() {
  try {
    const data = state.conversations.map(c => ({
      id: c.id, title: c.title, messages: c.messages,
      time: c.time,
      ...(c.expertContext ? { expertContext: c.expertContext } : {}),
      ...(c.expertId ? { expertId: c.expertId } : {}),
      ...(c.isAgent ? { isAgent: true } : {}),
    }));
    localStorage.setItem(CONV_STORAGE_KEY, JSON.stringify(data));
  } catch(e) { /* localStorage full, silently ignore */ }
}

function loadConversations() {
  try {
    const raw = localStorage.getItem(CONV_STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw).filter(c => Array.isArray(c.messages) && c.messages.length > 0);
      if (Array.isArray(data) && data.length > 0) {
        state.conversations = data;
        state.activeConv = data[0].id;
        return;
      }
    }
  } catch(e) { /* corrupted data, fall back to default */ }
  // Fallback default
  state.conversations = [{ id: 'default', title: '制作 TangProp AI 助手', messages: [], time: '刚刚' }];
  state.activeConv = 'default';
}

// ── Init ──
async function init() {
  try {
    const chatBottomHint = document.getElementById('chatBottomHint');
    if (chatBottomHint) chatHintDefaultParent = chatBottomHint.parentElement;
    loadConversations();
    try { await loadModels(); } catch (e) { console.warn('loadModels:', e); }
    try { await loadImageModels(); } catch (e) { console.warn('loadImageModels:', e); }
    setupDefaultSelection();
    renderTasks();
    initTheme();
    initUser();
    updateInputMode();
    initAvatarUpload();
    initWorkbenchResizer();
    initChatResizer();
    renderChatPreviewEmpty();
    initInteractiveFeatures();
  } catch (e) {
    console.error('Init failed:', e);
    showToast('页面加载异常，请刷新页面或检查网络连接');
  }
  // 昵称输入字数统计
  const nickInput = document.getElementById('settingsNickname');
  if (nickInput) {
    nickInput.addEventListener('input', () => {
      document.getElementById('nicknameCharCount').textContent = `${nickInput.value.length}/20`;
    });
  }
}

function initAvatarUpload() {
  const dz = document.getElementById('avatarDropzone');
  const fileInput = document.getElementById('avatarFileInput');
  if (!dz || !fileInput) return;
  // 点击触发文件选择
  dz.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) handleAvatarFile(e.target.files[0]);
  });
  // 拖放
  dz.addEventListener('dragover', (e) => {
    e.preventDefault();
    dz.classList.add('dragover');
  });
  dz.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dz.classList.remove('dragover');
  });
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) handleAvatarFile(e.dataTransfer.files[0]);
  });
}

function initUser() {
  const saved = localStorage.getItem('tangprop-auth');
  if (saved) {
    try {
      currentUser = JSON.parse(saved);
      applyUser();
    } catch (e) { showLogin(); }
  } else { showLogin(); }
}

function applyUser() {
  if (!currentUser) return;
  const name = currentUser.name || currentUser.email || currentUser.phone || 'User';
  const displayId = currentUser.email || currentUser.phone || currentUser.id || name;
  const avatar = currentUser.avatar || name.charAt(0).toUpperCase();
  document.getElementById('userIdDisplay').textContent = displayId;
  document.getElementById('userName').textContent = name;
  // 更新头像
  const avatarEl = document.querySelector('.user-bar .avatar');
  if (avatarEl) {
    if (avatar && avatar.startsWith('data:')) {
      avatarEl.textContent = '';
      avatarEl.style.backgroundImage = `url(${avatar})`;
    } else {
      avatarEl.textContent = avatar;
      avatarEl.style.backgroundImage = '';
    }
  }
  const subEl = document.getElementById('userSubtitle');
  if (subEl) subEl.textContent = currentUser.plan || '体验版';
  document.getElementById('loginOverlay').classList.remove('open');
}

async function handleLogin() {
  const btn = document.getElementById('loginBtn');
  const err = document.getElementById('loginError');

  // 仅邮箱登录
  const email = document.getElementById('loginEmail').value.trim();
  const code = document.getElementById('loginEmailCode').value.trim();

  if (!/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email)) {
    err.textContent = '请输入有效的邮箱地址'; return;
  }
  if (!/^\d{4,6}$/.test(code)) {
    err.textContent = '请输入 4-6 位验证码'; return;
  }

  btn.disabled = true; btn.textContent = '登录中...'; err.textContent = '';

  try {
    const res = await apiFetch(`${API}/auth/email-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(apiErrorDetail(data, '登录失败'));
    currentUser = { ...data.user, token: data.token };
    localStorage.setItem('tangprop-auth', JSON.stringify(currentUser));
    applyUser();
    showToast('登录成功');
  } catch (e) {
    err.textContent = e.message;
    btn.disabled = false; btn.textContent = '登录';
  }
}

async function sendEmailVerifyCode() {
  const email = document.getElementById('loginEmail').value.trim();
  const btn = document.getElementById('sendEmailCodeBtn');
  const err = document.getElementById('loginError');
  if (!/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email)) {
    err.textContent = '请输入有效的邮箱地址'; return;
  }
  err.textContent = '';
  btn.disabled = true; btn.textContent = '发送中...';
  try {
    const res = await apiFetch(`${API}/auth/send-email-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(apiErrorDetail(data, '发送失败'));
    let sec = 60;
    btn.textContent = `${sec}s`;
    const timer = setInterval(() => {
      sec--;
      if (sec <= 0) { clearInterval(timer); btn.disabled = false; btn.textContent = '获取验证码'; }
      else btn.textContent = `${sec}s`;
    }, 1000);
    if (data.dev_code) {
      document.getElementById('loginEmailCode').value = data.dev_code;
      err.style.color = 'var(--accent)';
      err.textContent = `开发模式：验证码 ${data.dev_code}（未配置 SMTP，未真实发邮件）`;
    } else {
      err.style.color = 'var(--success)';
      err.textContent = '验证码已发送至邮箱，请查收';
    }
  } catch (e) {
    btn.disabled = false; btn.textContent = '获取验证码';
    err.style.color = '';
    err.textContent = e.message;
  }
}

function showLogin() { document.getElementById('loginOverlay').classList.add('open'); }

async function logout() {
  // 通知后端注销 session
  if (currentUser && currentUser.token) {
    try {
      await apiFetch(`${API}/auth/logout?token=${encodeURIComponent(currentUser.token)}`, { method: 'POST' });
    } catch (e) { /* 忽略网络错误，前端照样清理 */ }
  }
  // 清除用户状态
  currentUser = null;
  localStorage.removeItem('tangprop-auth');
  localStorage.removeItem(CONV_STORAGE_KEY);
  closeUserMenu();
  // 重置应用状态
  state.conversations = [{ id: 'default', title: '制作 TangProp AI 助手', messages: [], time: '刚刚' }];
  state.activeConv = 'default';
  state.inChat = false;
  state.activeScene = null;
  state.loading = false;
  // 重置 UI
  document.getElementById('userIdDisplay').textContent = '未登录';
  document.getElementById('userName').textContent = '未登录';
  const subEl = document.getElementById('userSubtitle');
  if (subEl) subEl.textContent = '点击登录';
  const avatarEl = document.querySelector('.user-bar .avatar');
  if (avatarEl) { avatarEl.textContent = 'T'; avatarEl.style.backgroundImage = ''; }
  // 关闭设置面板（如果开着）
  closeSettings();
  // 清空聊天区域
  const msgEl = document.getElementById('messages');
  if (msgEl) msgEl.innerHTML = '';
  // 回到首页
  closeWorkbench();
  renderTasks();
  // 显示登录页
  showLogin();
}

// ── Theme（深色模式暂关，按钮保留）──
const DARK_THEME_ENABLED = false;

function initTheme() {
  setTheme('light', true);
}

function setTheme(theme, save = true) {
  if (theme === 'dark' && !DARK_THEME_ENABLED) {
    if (typeof showToast === 'function') showToast('深色模式暂未开放');
    theme = 'light';
  }
  document.documentElement.setAttribute('data-theme', 'light');
  const lightBtn = document.getElementById('themeLight');
  const darkBtn = document.getElementById('themeDark');
  if (lightBtn) lightBtn.classList.add('active');
  if (darkBtn) {
    darkBtn.classList.remove('active');
    darkBtn.classList.add('disabled');
  }
  if (save) localStorage.setItem('tangprop-theme', 'light');
}

// ── User Menu ──
function toggleUserMenu() {
  const menu = document.getElementById('userMenu');
  const isOpen = menu.classList.contains('open');
  if (isOpen) closeUserMenu();
  else { closeModelDropdown(); menu.classList.add('open'); document.getElementById('dropdownBackdrop').classList.add('open'); }
}
function closeUserMenu() {
  document.getElementById('userMenu').classList.remove('open');
  document.getElementById('dropdownBackdrop').classList.remove('open');
}

// ── Settings Panel ──
let settingsSelectedAvatar = 'T'; // 可以是 data URL 或单个字符
let settingsAvatarIsImage = false;

function openSettings() {
  closeUserMenu();
  // 初始化当前值
  const currentName = currentUser ? (currentUser.name || currentUser.phone || '') : '';
  const currentAvatar = (currentUser && currentUser.avatar) ? currentUser.avatar : (currentName.charAt(0) || 'T');
  settingsSelectedAvatar = currentAvatar;
  settingsAvatarIsImage = currentAvatar.startsWith('data:');
  // 填充昵称
  const nickInput = document.getElementById('settingsNickname');
  nickInput.value = currentName;
  document.getElementById('nicknameCharCount').textContent = `${currentName.length}/20`;
  // 渲染头像预览
  renderAvatarPreview();
  // 显示面板
  document.getElementById('settingsOverlay').classList.add('open');
  setTimeout(() => nickInput.focus(), 200);
}

function renderAvatarPreview() {
  const preview = document.getElementById('settingsAvatarPreview');
  if (settingsAvatarIsImage) {
    preview.textContent = '';
    preview.style.backgroundImage = `url(${settingsSelectedAvatar})`;
  } else {
    preview.textContent = settingsSelectedAvatar;
    preview.style.backgroundImage = '';
  }
}

function handleAvatarFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    showToast('请选择图片文件');
    return;
  }
  if (file.size > 2 * 1024 * 1024) {
    showToast('图片不能超过 2MB');
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    settingsSelectedAvatar = e.target.result;
    settingsAvatarIsImage = true;
    renderAvatarPreview();
  };
  reader.readAsDataURL(file);
}

function closeSettings() {
  document.getElementById('settingsOverlay').classList.remove('open');
}

async function saveProfile() {
  if (!currentUser || !currentUser.token) { showToast('请先登录'); return; }
  const name = document.getElementById('settingsNickname').value.trim();
  const avatar = settingsSelectedAvatar;
  if (!name) { showToast('昵称不能为空'); return; }

  const btn = document.getElementById('settingsSaveBtn');
  btn.disabled = true; btn.textContent = '保存中...';
  try {
    const res = await apiFetch(`${API}/auth/update-profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: currentUser.token, name, avatar }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(apiErrorDetail(data, '保存失败'));
    // 更新本地状态
    currentUser.name = data.user.name;
    currentUser.avatar = data.user.avatar;
    localStorage.setItem('tangprop-auth', JSON.stringify(currentUser));
    applyUser();
    showToast('保存成功');
    closeSettings();
  } catch (e) {
    showToast(e.message);
  } finally {
    btn.disabled = false; btn.textContent = '保存';
  }
}


function copyUserId() {
  const id = currentUser?.email || currentUser?.phone || currentUser?.id || currentUser?.name || '';
  if (!id) { showToast('请先登录'); return; }
  navigator.clipboard.writeText(String(id)).then(() => showToast('已复制用户 ID')).catch(() => showToast('复制失败'));
}

function openTaskSearch() {
  openActionPanel('搜索任务', `
    <input class="action-search-input" id="taskSearchInput" placeholder="搜索标题或对话内容…" autofocus oninput="runTaskSearch(this.value)">
    <div id="taskSearchResults"></div>
  `);
  setTimeout(() => {
    const inp = document.getElementById('taskSearchInput');
    if (inp) { inp.focus(); runTaskSearch(''); }
  }, 80);
}

function runTaskSearch(q) {
  const el = document.getElementById('taskSearchResults');
  if (!el) return;
  const query = (q || '').trim().toLowerCase();
  const matches = state.conversations.filter(c =>
    !query ||
    (c.title || '').toLowerCase().includes(query) ||
    (c.messages || []).some(m => (m.content || '').toLowerCase().includes(query))
  );
  if (!matches.length) {
    el.innerHTML = '<div class="action-empty">' + (query ? '未找到匹配任务' : '输入关键词搜索') + '</div>';
    return;
  }
  el.innerHTML = matches.map(c => {
    const preview = (c.messages || []).slice(-1)[0]?.content?.slice(0, 60) || '空对话';
    return `<div class="action-list-item" onclick="switchConv('${c.id}'); closeActionPanel(); showToast('已跳转：${escapeHtml(c.title)}')">
      <div><div>${escapeHtml(c.title)}</div><div class="meta">${escapeHtml(preview)}</div></div>
      <span class="badge">${escapeHtml(c.time || '')}</span>
    </div>`;
  }).join('');
}

function shareConversation() {
  const conv = getActiveConv();
  if (!conv.messages || !conv.messages.length) {
    showToast('当前对话为空');
    return;
  }
  openActionPanel('分享对话', `
    <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;">导出当前对话或复制到剪贴板</p>
    <div class="action-btn-row" style="justify-content:flex-start;">
      <button class="action-btn primary" onclick="copyConversationText()">复制全文</button>
      <button class="action-btn secondary" onclick="downloadConversation()">下载 Markdown</button>
    </div>
  `);
}

function copyConversationText() {
  const conv = getActiveConv();
  const text = formatConversationExport(conv);
  navigator.clipboard.writeText(text).then(() => {
    showToast('对话已复制到剪贴板');
    closeActionPanel();
  }).catch(() => showToast('复制失败'));
}

function downloadConversation() {
  const conv = getActiveConv();
  const text = formatConversationExport(conv);
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (conv.title || '对话') + '.md';
  a.click();
  URL.revokeObjectURL(a.href);
  showToast('已开始下载');
  closeActionPanel();
}

function formatConversationExport(conv) {
  const lines = ['# ' + (conv.title || '对话'), '', `导出时间：${new Date().toLocaleString()}`, ''];
  (conv.messages || []).forEach(m => {
    const who = m.role === 'user' ? '你' : 'TangProp';
    lines.push(`## ${who}`, '', m.content || '', '');
  });
  return lines.join('\n');
}

function openHelpFeedback() {
  closeUserMenu();
  openActionPanel('帮助与反馈', `
    <p style="font-size:13px;color:var(--text-secondary);margin-bottom:10px;">描述你遇到的问题或建议，我们会尽快处理。</p>
    <textarea class="action-textarea" id="feedbackText" placeholder="请输入反馈内容…"></textarea>
    <div class="action-btn-row">
      <button class="action-btn secondary" onclick="closeActionPanel()">取消</button>
      <button class="action-btn primary" onclick="submitFeedback()">提交反馈</button>
    </div>
  `);
}

function submitFeedback() {
  const text = document.getElementById('feedbackText')?.value?.trim();
  if (!text) { showToast('请输入反馈内容'); return; }
  const body = `TangProp 反馈\n用户：${currentUser?.email || '未登录'}\n时间：${new Date().toLocaleString()}\n内容：${text}`;
  navigator.clipboard.writeText(body).then(() => {
    addNotification('反馈已提交', '感谢你的反馈，内容已复制，可发送至 support@tangprop.com', true);
    showToast('反馈已复制，感谢！');
    closeActionPanel();
  }).catch(() => showToast('提交失败'));
}

async function checkForUpdates() {
  closeUserMenu();
  try {
    const res = await apiFetch(`${API}/health`);
    const data = res.ok ? await res.json().catch(() => ({})) : {};
    const serverVer = data.version || data.app_version || null;
    const msg = serverVer
      ? (serverVer === APP_VERSION ? `当前已是最新版本 v${APP_VERSION}` : `客户端 v${APP_VERSION}，服务端 v${serverVer}`)
      : (res.ok ? `服务运行正常 · v${APP_VERSION}` : '无法连接服务器');
    showToast(msg);
    if (res.ok) addNotification('检查更新', msg, true);
  } catch (e) {
    showToast('无法连接服务器，请稍后重试');
  }
}

function rateMsg(btn, score) {
  btn.closest('.msg-actions')?.querySelectorAll('.msg-action-btn').forEach(b => b.classList.remove('rated'));
  btn.classList.add('rated');
  const msgEl = btn.closest('.msg');
  const msgId = msgEl?.id || '';
  const conv = getActiveConv();
  if (msgId) {
    const ratings = loadRatings();
    ratings[conv.id + ':' + msgId] = score;
    localStorage.setItem(RATINGS_KEY, JSON.stringify(ratings));
  }
  showToast(score > 0 ? '感谢反馈！' : '已记录，我们会改进');
}

function forwardMsg(btn) {
  const bubble = btn.closest('.msg')?.querySelector('.msg-bubble');
  if (!bubble) return;
  state.forwardMessageText = bubble.innerText;
  openForwardPanel();
}
function showToast(msg) {
  const toast = document.createElement('div');
  toast.textContent = msg;
  toast.style.cssText = `
    position: fixed; bottom: 100px; left: 50%; transform: translateX(-50%);
    background: var(--text); color: var(--bg); padding: 10px 18px;
    border-radius: 100px; font-size: 13px; z-index: 1000;
    box-shadow: 0 8px 24px rgba(0,0,0,0.2); pointer-events: none;
  `;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2000);
}

// ── Models ──
async function loadModels() {
  try {
    const res = await apiFetch(`${API}/models`);
    state.providers = await res.json();
    renderModelDropdown();
  } catch (e) {
    console.error('Failed to load models:', e);
    document.getElementById('modelDropdownList').innerHTML = `
      <div style="padding:24px;text-align:center;color:var(--danger);font-size:13px;">
        无法连接后端服务<br><small>请确保 python main.py 已启动 (端口 8080)</small>
      </div>`;
    document.getElementById('modelSelector').classList.add('offline');
  }
}

async function loadImageModels() {
  try {
    const res = await apiFetch(`${API}/image/models`);
    if (!res.ok) return;
    const models = await res.json();
    if (Array.isArray(models) && models.length) {
      state.imageModels = models;
      const configured = models.filter(m => m.configured !== false);
      const defaultM = models.find(m => m.default)
        || configured.find(m => m.id.startsWith('doubao:'))
        || configured[0]
        || models[0];
      const saved = localStorage.getItem(IMAGE_MODEL_KEY);
      if (saved && models.find(m => m.id === saved && m.configured !== false)) {
        state.imageModel = saved;
      } else if (!models.find(m => m.id === state.imageModel && m.configured !== false)) {
        state.imageModel = defaultM?.id || 'zimage';
      }
      updateImageModelDisplay();
      renderImageModelDropdown();
    }
  } catch (e) {
    console.warn('Failed to load image models:', e);
  }
}

function renderImageModelDropdown() {
  const el = document.getElementById('imageModelDropdownList');
  if (!el) return;
  const models = state.imageModels || [];
  if (!models.length) {
    el.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-tertiary);font-size:13px;">暂无可用生图模型</div>';
    return;
  }
  el.innerHTML = models.map(m => {
    const active = m.id === state.imageModel ? ' active' : '';
    const disabled = m.configured === false ? ' disabled' : '';
    const tag = m.free ? '<span class="model-tag free">免费</span>' : '';
    const warn = m.configured === false ? '<span class="model-tag" style="opacity:.7">未配置</span>' : '';
    return `<div class="model-item${active}${disabled}" onclick="selectImageModel('${escapeHtml(m.id)}')">
      <div class="model-item-main"><span class="model-item-name">${escapeHtml(m.name || m.id)}</span>${tag}${warn}</div>
      <div class="model-item-sub">${escapeHtml(m.provider || '')}</div>
    </div>`;
  }).join('');
}

function updateImageModelDisplay() {
  const nameEl = document.getElementById('imageModelName');
  const dotEl = document.getElementById('imageModelDot');
  if (!nameEl) return;
  const cur = (state.imageModels || []).find(m => m.id === state.imageModel);
  const label = cur?.name?.split('（')[0]?.trim() || state.imageModel || 'Z-Image';
  nameEl.textContent = label;
  if (dotEl) {
    dotEl.className = 'dot' + (cur && cur.configured === false ? ' offline' : '');
  }
}

function positionImageModelDropdown() {
  const dd = document.getElementById('imageModelDropdown');
  const selector = document.getElementById('imageModelSelector');
  if (!dd || !selector) return;

  if (isMobileLayout()) {
    dd.style.top = 'auto';
    dd.style.bottom = '0px';
    dd.style.left = '0px';
    dd.style.right = '0px';
    dd.style.width = '100%';
    dd.style.maxHeight = 'min(72vh, 580px)';
    return;
  }

  const rect = selector.getBoundingClientRect();
  const spaceAbove = Math.max(160, rect.top - 24);
  const ddHeight = Math.min(360, spaceAbove);
  let left = rect.left;
  if (left + 320 > window.innerWidth - 12) left = Math.max(12, window.innerWidth - 320 - 12);
  dd.style.right = 'auto';
  dd.style.width = '';
  dd.style.top = 'auto';
  dd.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
  dd.style.left = left + 'px';
  dd.style.maxHeight = ddHeight + 'px';
}

function toggleImageModelDropdown(e) {
  e.stopPropagation();
  const dd = document.getElementById('imageModelDropdown');
  const bd = document.getElementById('dropdownBackdrop');
  const isOpen = dd.classList.contains('open');
  if (isOpen) closeImageModelDropdown();
  else {
    closeModelDropdown();
    closeUserMenu();
    renderImageModelDropdown();
    positionImageModelDropdown();
    dd.classList.add('open');
    bd.classList.add('open');
  }
}

function closeImageModelDropdown() {
  const dd = document.getElementById('imageModelDropdown');
  if (dd) dd.classList.remove('open');
  const bd = document.getElementById('dropdownBackdrop');
  if (bd && !document.getElementById('modelDropdown')?.classList.contains('open')) {
    bd.classList.remove('open');
  }
}

function selectImageModel(modelId) {
  const m = (state.imageModels || []).find(x => x.id === modelId);
  if (!m || m.configured === false) {
    showToast(m?.configured === false ? '该模型尚未配置，见下方说明' : '模型不可用');
    return;
  }
  state.imageModel = modelId;
  localStorage.setItem(IMAGE_MODEL_KEY, modelId);
  updateImageModelDisplay();
  renderImageModelDropdown();
  closeImageModelDropdown();
  showToast('生图模型：' + (m.name?.split('（')[0] || modelId));
}

function setupDefaultSelection() {
  // Start in Auto mode by default
  state.autoMode = true;
  state.selectedProvider = null;
  state.selectedModel = null;
  state.autoPrediction = null;
  updateModelDisplay();
}

// ── Sidebar Tasks ──
function formatTime(date) {
  const now = new Date();
  const diff = Math.floor((now - date) / 1000);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff/60)}分钟前`;
  if (diff < 86400) return `${Math.floor(diff/3600)}小时前`;
  return `${Math.floor(diff/86400)}天前`;
}

function renderTasks() {
  const el = document.getElementById('taskList');
  document.getElementById('taskCount').textContent = `(${state.conversations.length})`;
  el.innerHTML = state.conversations.map(c => `
    <div class="task-item ${!state.draftAgent && c.id === state.activeConv ? 'active' : ''}" onclick="switchConv('${c.id}')">
      <div class="task-icon"></div>
      <div class="task-info">
        <div class="task-title">${c.title}</div>
        <div class="task-time">${c.time || '刚刚'}</div>
      </div>
      <div class="task-menu" onclick="event.stopPropagation(); deleteTask('${c.id}')"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></div>
    </div>
  `).join('');
}

function newAgent() {
  state.draftAgent = true;
  state.pendingExpert = null;
  state.inChat = false;
  state.activeScene = null;
  closeExpertCenter();
  closeInspirationLibrary();
  const thread = document.getElementById('wbChatThread');
  if (thread) {
    thread.dataset.demoRan = '';
    thread.dataset.seeded = '';
    thread.innerHTML = '';
  }
  renderWbEmpty();
  const titleEl = document.getElementById('wbTaskTitle');
  if (titleEl) titleEl.textContent = '新任务';
  renderTasks();
  updateInputMode();
  document.getElementById('messages').innerHTML = '';
  document.getElementById('userInput').value = '';
  autoResize(document.getElementById('userInput'));
  renderInputTags();
  renderExpertTags(null);
  openWorkbench();
  setTimeout(() => {
    const wbInput = document.getElementById('wbChatInput');
    if (wbInput) wbInput.focus();
  }, 80);
}

function ensureAgentTask(firstText) {
  if (state.draftAgent) {
    const id = 'conv_' + Date.now();
    const title = firstText.slice(0, 24) + (firstText.length > 24 ? '...' : '');
    const conv = { id, title, messages: [], time: '刚刚', isAgent: true };
    state.conversations.unshift(conv);
    state.activeConv = id;
    state.draftAgent = false;
    const titleEl = document.getElementById('wbTaskTitle');
    if (titleEl) titleEl.textContent = title;
    renderTasks();
    saveConversations();
    return conv;
  }
  const conv = state.conversations.find(c => c.id === state.activeConv);
  if (conv && conv.isAgent) return conv;
  const id = 'conv_' + Date.now();
  const title = firstText.slice(0, 24) + (firstText.length > 24 ? '...' : '');
  const newConv = { id, title, messages: [], time: '刚刚', isAgent: true };
  state.conversations.unshift(newConv);
  state.activeConv = id;
  const titleEl = document.getElementById('wbTaskTitle');
  if (titleEl) titleEl.textContent = title;
  renderTasks();
  saveConversations();
  return newConv;
}

function deleteTask(id) {
  state.conversations = state.conversations.filter(c => c.id !== id);
  saveConversations();
  if (state.activeConv === id) {
    if (state.conversations.length) switchConv(state.conversations[0].id);
    else newAgent();
  } else renderTasks();
}

// ── Agent Workbench (WorkBuddy-style: project | chat | preview) ──
function getTangpropAssetUrl(name) {
  try {
    return new URL(name, document.baseURI || location.href).href;
  } catch (_) {
    return name;
  }
}

/** New Agent 右侧预览：对齐当前真实登录页样式 */
function getWbPreviewHtml() {
  const logoMain = getTangpropAssetUrl('1.png');
  const logoHint = getTangpropAssetUrl('2.png');
  const logoCorner = getTangpropAssetUrl('3.png');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }
body {
  min-height: 100vh;
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", Roboto, sans-serif;
  background: #fff;
  color: #333;
}
.login-overlay {
  display: flex;
  align-items: stretch;
  justify-content: stretch;
  min-height: 100vh;
  width: 100%;
}
.login-side {
  flex: 1 1 50%;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 24px;
  background: #fff;
}
.login-video-side {
  flex: 1 1 50%;
  min-width: 0;
  background: linear-gradient(135deg, #e8eaec 0%, #d6d9de 100%);
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}
.login-video-corner-logo {
  position: absolute;
  left: 36px;
  bottom: 28px;
  width: 96px;
  height: auto;
  pointer-events: none;
}
.login-card {
  width: min(380px, 100%);
}
.login-brand { text-align: center; margin-bottom: 36px; }
.login-brand-logo {
  display: block;
  width: 220px;
  max-width: 80%;
  height: auto;
  margin: 0 auto 20px;
}
.login-brand-greet,
.login-brand-sub {
  font-size: 14px;
  color: #666;
  letter-spacing: 0.3px;
  line-height: 1.5;
}
.login-brand-greet { margin-bottom: 4px; }
.login-form { display: flex; flex-direction: column; gap: 16px; }
.login-input-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  background: #fff;
  border: 1px solid #e5e5e5;
  border-radius: 10px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.login-input-row:focus-within {
  border-color: #52B6FB;
  box-shadow: 0 0 0 3px rgba(82,182,251,0.12);
}
.login-input-row input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-size: 14px;
  color: #333;
  font-family: inherit;
}
.login-input-row input::placeholder { color: #b8b8b8; }
.code-row { padding-right: 6px; }
.send-code-btn {
  border: none;
  background: transparent;
  color: #52B6FB;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  padding: 6px 4px;
}
.login-btn {
  width: 100%;
  padding: 15px;
  border-radius: 10px;
  border: none;
  background: #1a1a1a;
  color: #fff;
  font-size: 15px;
  font-weight: 500;
  letter-spacing: 4px;
  cursor: pointer;
  margin-top: 4px;
  font-family: inherit;
}
.login-btn:hover { background: #000; }
.login-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-top: 4px;
  font-size: 12px;
  color: #999;
}
.login-hint img { width: 14px; height: 14px; flex-shrink: 0; }
@media (max-width: 720px) {
  .login-video-side { display: none; }
  .login-side { flex: 1 1 100%; }
  .login-brand-logo { width: 180px; }
}
</style>
</head>
<body>
<div class="login-overlay">
  <div class="login-side">
    <div class="login-card">
      <div class="login-brand">
        <img class="login-brand-logo" src="${logoMain}" alt="TangProp">
        <p class="login-brand-greet">HELLO! 我是TangProp的智能助手PUPU</p>
        <p class="login-brand-sub">有什么可以搭把手的？</p>
      </div>
      <div class="login-form">
        <div class="login-input-row">
          <input type="email" placeholder="请输入电子邮箱地址" autocomplete="email">
        </div>
        <div class="login-input-row code-row">
          <input type="text" placeholder="请输入验证码" maxlength="6">
          <button class="send-code-btn" type="button">获取验证码</button>
        </div>
        <button class="login-btn" type="button">登录</button>
        <div class="login-hint">
          <img src="${logoHint}" alt="">
          <span>未注册账号验证后自动创建</span>
        </div>
      </div>
    </div>
  </div>
  <div class="login-video-side">
    <img class="login-video-corner-logo" src="${logoCorner}" alt="TangProp">
  </div>
</div>
</body>
</html>`;
}

const WB_DEMO_CONVERSATION = [
  {
    role: 'user',
    text: '把登录页改成现在的新样式：左侧白底表单 + 右侧浅灰宣传区，邮箱验证码登录，黑色登录按钮'
  },
  {
    role: 'agent',
    thinking: '用户要同步登录页视觉：去掉旧毛玻璃卡片，改为左右分栏；品牌文案改为 PUPU 招呼语；输入改为邮箱+验证码；主按钮改为黑色。我先定位 .login-overlay 相关结构再改。',
    tools: [
      { icon: '🔍', text: '已搜索 <code>.login-overlay</code>、<code>.login-side</code>、<code>.login-video-side</code>' },
      { icon: '📄', text: '已读取登录页品牌区与表单结构（邮箱验证码）' },
      { icon: '📄', text: '已对齐 <code>1.png / 2.png / 3.png</code> 品牌素材路径' }
    ],
    summary: '深度思考',
    text: '已按新登录界面重构预览：左右分栏、邮箱验证码、黑色登录按钮，副文案为「有什么可以搭把手的？」。'
  }
];

/* ============================================================
   Agent Workbench — 演示数据
   ============================================================ */
const WB_CHAT_DEMO = [
  { role: 'user', text: '帮我把 TangProp 登录页改成新样式：左右分栏、白底表单、右侧浅灰宣传区，邮箱验证码登录' },
  { role: 'agent', thinking: '用户要求对齐新登录界面：去掉毛玻璃卡片与渐变按钮，改成 login-side + login-video-side 分栏，并换成邮箱验证码与黑色登录按钮。' },
  { role: 'agent', tools: [
    { icon: '🔍', text: '搜索 <code>.login-overlay</code>、<code>.login-card</code>、<code>.login-btn</code>' },
    { icon: '📄', text: '读取登录页 HTML：品牌 logo、邮箱表单、右侧宣传区' }
  ]},
  { role: 'agent', text: '已定位到登录页代码。开始按新样式重构：\n```css\n.login-overlay { display:flex; background:#fff; }\n.login-side { flex:1; background:#fff; }\n.login-video-side {\n  flex:1;\n  background: linear-gradient(135deg, #e8eaec, #d6d9de);\n}\n.login-btn {\n  background:#1a1a1a;\n  letter-spacing:4px;\n  border-radius:10px;\n}\n```\n\n表单改为邮箱 + 验证码，品牌文案使用 PUPU 招呼语。' },
  { role: 'agent', text: '✅ 新登录页已渲染到右侧预览。左侧白底表单，右侧浅灰宣传区，可直接对照线上登录界面。' }
];

let wbDemoTimer = null;
let wbResizerActive = false;

/* ---- Open / Close ---- */
function openWorkbench() {
  closeInspirationLibrary();
  closeExpertCenter();
  document.getElementById('agentWorkbench').classList.add('active');
  const thread = document.getElementById('wbChatThread');
  if (thread && thread.children.length === 0 && !thread.dataset.seeded) {
    thread.dataset.seeded = 'true';
    addWbThreadMsg({
      role: 'agent',
      text: '你好！告诉我你想做什么 —— 例如「做一个苹果风格的首页」「给我画一个登录卡片」「设计一个数据看板」。'
    });
    renderWbEmpty();
  }
}

function closeWorkbench() {
  document.getElementById('agentWorkbench').classList.remove('active');
  if (wbDemoTimer) clearTimeout(wbDemoTimer);
  state.draftAgent = false;
}

// ============================================================
// Expert Center — 专家中心
// ============================================================

const EXPERTS_DATA = [
  {
    id: 'finance-investment-expert',
    name: '金融投资分析专家',
    shortName: '金融投资',
    hook: '看不懂财报、不敢下手？',
    valueLine: '帮你算清「值不值买、风险多大、该不该动」',
    solves: ['个股值不值', '持仓风险', '该不该买'],
    pains: ['看到财报一堆数字，不知道公司到底赚不赚钱', '买了股票心里没底，跌一点就慌', '想投资但不知道现在进场还是再等等'],
    helps: [
      { action: '读财报', desc: '用大白话解释关键指标，判断值不值得买' },
      { action: '诊风险', desc: '看你的持仓分散度和最大回撤，哪里太集中' },
      { action: '给框架', desc: '给出带条件的分析思路，不帮你喊单' }
    ],
    profession: '资深金融投资分析师',
    icon: '💰',
    iconBg: 'rgba(0,200,151,0.1)',
    iconColor: '#00c897',
    category: '08-FinanceInvestment',
    tags: ['投资分析', '风险评估'],
    quickPrompts: ['这只股票值不值得买？帮我看看', '我的持仓风险大吗？', '现在适合加仓还是观望？'],
    outputGuide: '用户未指定股票/代码时：必须先给出「值不值得买」5 步判断框架（估值、盈利质量、护城河、风险点、仓位建议），附一个假设示例结论，最后再问股票代码。',
    fewShot: '用户：这只股票值不值得买？\n助手：\n## 结论\n是否值得买取决于五个维度：估值贵不贵、盈利稳不稳、有没有护城河、下行风险多大、以及你的仓位是否匹配风险承受能力。在未指定具体股票前，先用这套框架自检。\n## 分析要点\n1. **估值**：PE/PB 相对历史与同行；2. **盈利质量**：营收增速、毛利率、现金流；3. **护城河**：品牌/成本/网络效应；4. **风险**：行业周期、负债、政策；5. **仓位**：单票不超过总仓 20%（示例）。\n## 建议\n- 若 PE 明显高于行业且增速放缓 → 偏贵，观望\n- 若盈利稳定+估值合理+有护城河 → 可考虑分批建仓\n告诉我股票代码（如 600519），我可按这套框架给你具体结论。',
    assistantPrefill: '## 结论\n是否值得买取决于五个维度：估值贵不贵、盈利稳不稳、有没有护城河、下行风险多大、以及仓位是否匹配风险承受能力。',
    description: '精通价值投资、技术分析、风险管理与行为金融学，擅长个股分析、组合构建与投资决策评估。',
    knowledge: [
      { subject: '价值投资', source: 'Graham & Dodd《Security Analysis》', content: '内在价值、安全边际、市场先生、护城河五类型、能力圈原则、Graham选股标准' },
      { subject: '技术分析', source: '道氏理论 / Wilder', content: 'RSI超买超卖、MACD金叉死叉、均线系统、支撑阻力位、量价配合验证' },
      { subject: '风险管理', source: 'Kelly Criterion / Tharp', content: '凯利公式仓位计算、止损体系（硬/软/移动/时间）、风险收益比评估、最大回撤管理' },
      { subject: '投资组合理论', source: 'Markowitz / Sharpe (Nobel)', content: '均值方差优化、有效前沿、CAPM模型与Beta系数、分散化原理、再平衡策略' },
      { subject: '行为金融学', source: 'Kahneman / Thaler (Nobel)', content: '8大认知偏差识别：损失厌恶、过度自信、确认偏差、锚定效应、羊群效应、处置效应、近因偏差、禀赋效应' },
      { subject: '巴菲特投资原则', source: '致伯克希尔股东信', content: '护城河评估、安全边际、长期持有、集中投资、逆向思维、管理层评估' }
    ],
    capabilities: ['个股分析（基本面+技术面双维度）', '投资组合评估与优化', '市场阶段判断', '风险诊断与认知偏差识别', '仓位规划（凯利公式）'],
    constraints: [
      '永远不做绝对化预测，所有判断附带概率和条件',
      '必须包含风险提示，不论用户是否要求',
      '引用数据时注明来源和时间',
      '不推荐具体买卖点位，只提供分析框架和建议区间',
      '遵守中国证监会相关规定，不做非法投资咨询'
    ]
  },
  {
    id: 'legal-compliance-expert',
    name: '法律合规专家',
    shortName: '法律合规',
    hook: '合同有坑、怕踩雷？',
    valueLine: '签约前帮你揪出风险条款，避免事后扯皮',
    solves: ['审合同', '查合规', '维权指引'],
    pains: ['合同几十页看不懂，不知道有没有坑', '新业务不确定会不会违规', '被侵权了不知道该怎么维权'],
    helps: [
      { action: '审合同', desc: '标出高风险条款，告诉你该改哪里' },
      { action: '查合规', desc: '判断你的业务有没有数据、劳动、知产风险' },
      { action: '给路径', desc: '告诉你下一步该找谁、留什么证据' }
    ],
    profession: '资深法务合规顾问',
    icon: '⚖️',
    iconBg: 'rgba(82,182,251,0.1)',
    iconColor: '#52B6FB',
    category: '07-LegalCompliance',
    tags: ['合同审查', '合规风控'],
    quickPrompts: ['帮我看看这份合同有没有坑', '我这个业务有什么合规风险？', '被人抄袭了怎么办？'],
    assistantPrefill: '## 结论\n合同/合规问题要先看四个红线：主体是否有效、权利义务是否对等、违约与退出机制是否清晰、有没有隐藏的责任放大条款。',
    description: '精通合同法、公司法、知识产权法，擅长合同审查、合规风险诊断和法律咨询。',
    knowledge: [
      { subject: '合同法体系', source: '《民法典》合同编 (2021)', content: '合同成立三要素、合同效力分类、违约责任、审查要点清单（10项）、常见合同陷阱' },
      { subject: '公司法与公司治理', source: '《公司法》(2024修订)', content: '公司类型、股东权利、董监高义务、股权设计（代持/期权/AB股）、公司治理结构' },
      { subject: '知识产权法', source: '《专利法》《商标法》《著作权法》', content: '专利/商标/著作权/商业秘密保护、侵权判定标准、维权流程' },
      { subject: '数据合规', source: '《数据安全法》《个保法》《网安法》', content: '数据分类分级、个人信息处理原则、用户同意机制、数据跨境传输' },
      { subject: '劳动法', source: '《劳动法》《劳动合同法》', content: '劳动合同管理、工资工时、社保公积金、劳动争议处理、竞业限制' }
    ],
    capabilities: ['合同审查与风险标注', '合规风险评估', '知识产权保护策略', '劳动法咨询', '数据合规诊断'],
    constraints: [
      '不替代律师正式法律意见',
      '引用法律条文必须标注具体条款号',
      '涉及刑事犯罪必须建议咨询专业律师',
      '不提供避税方案',
      '保守客户秘密'
    ]
  },
  {
    id: 'code-tech-expert',
    name: '代码技术专家',
    shortName: '代码技术',
    hook: '代码跑不动、架构选不对？',
    valueLine: '帮你定位 bug、选技术栈、优化性能',
    solves: ['查 bug', '选架构', '提性能'],
    pains: ['线上突然变慢或报错，不知道哪里出问题', '新项目不知道用什么框架、怎么分层', '代码越写越乱，不敢改怕崩'],
    helps: [
      { action: '定位问题', desc: '根据报错和现象，帮你找到最可能的根因' },
      { action: '设计架构', desc: '给出可落地的技术选型和模块划分' },
      { action: 'Review', desc: '指出代码里的隐患和改法，附示例' }
    ],
    profession: '资深全栈架构师',
    icon: '💻',
    iconBg: 'rgba(168,85,247,0.1)',
    iconColor: '#a855f7',
    category: '05-CodeDevelopment',
    tags: ['架构设计', '代码审查'],
    quickPrompts: ['这段代码为什么报错？', '帮我设计这个系统的架构', '页面加载太慢怎么优化？'],
    assistantPrefill: '## 结论\n技术问题通常落在三层：需求是否清晰、架构是否合理、实现与运行环境是否匹配。先定位是哪一层，再往下拆。',
    description: '精通前后端开发、系统架构、DevOps和代码审查，擅长技术选型、性能优化和疑难排查。',
    knowledge: [
      { subject: '软件架构原则', source: 'SOLID (Robert C. Martin) / GoF设计模式', content: 'SOLID五大原则、23种设计模式（创建型/结构型/行为型）、架构模式（单体/微服务/Serverless/DDD）' },
      { subject: '前端开发体系', source: 'MDN / React / Vue 官方文档', content: 'HTML语义化与a11y、CSS Flexbox/Grid、ES6+特性、事件循环、框架对比选型、工程化（Webpack/Vite/ESLint）' },
      { subject: '后端开发体系', source: 'RESTful / Kubernetes 文档', content: 'API设计（REST/GraphQL/gRPC）、数据库（MySQL/Redis/MongoDB）、消息队列（Kafka/RabbitMQ）、缓存策略' },
      { subject: 'DevOps与云原生', source: 'CNCF Landscape', content: 'Docker容器化、Kubernetes编排、CI/CD流水线、监控可观测性（Prometheus/Grafana/ELK）' },
      { subject: '代码审查标准', source: 'OWASP Top 10 / Clean Code', content: '审查维度（正确性/可读性/安全性/性能）、代码坏味道清单、安全漏洞清单、性能反模式' }
    ],
    capabilities: ['系统架构设计', '代码审查与质量评估', '性能优化诊断', '技术选型建议', 'DevOps方案设计'],
    constraints: [
      '代码必须可运行，不写伪代码',
      '注明依赖版本',
      '考虑向后兼容',
      '安全第一，遵循OWASP规范'
    ]
  },
  {
    id: 'marketing-expert',
    name: '市场营销专家',
    shortName: '市场营销',
    hook: '投了钱没转化、内容没人看？',
    valueLine: '帮你找到增长杠杆，写出能转化的方案',
    solves: ['做方案', '提转化', '选渠道'],
    pains: ['广告花了钱但转化很差，不知道哪里出问题', '小红书/抖音发了内容没流量', '产品上线了不知道怎么推广'],
    helps: [
      { action: '做方案', desc: '从定位到渠道，给你一份可执行的推广计划' },
      { action: '提转化', desc: '分析漏斗哪一步流失最多，怎么改' },
      { action: '写内容', desc: '给出标题、结构和钩子，适配各平台' }
    ],
    profession: '资深营销战略顾问',
    icon: '📈',
    iconBg: 'rgba(255,170,59,0.1)',
    iconColor: '#ffaa3b',
    category: '03-MarketingSales',
    tags: ['增长营销', '内容营销'],
    quickPrompts: ['新产品怎么推广？给我个方案', '转化率低怎么办？', '帮我写一条小红书文案'],
    assistantPrefill: '## 结论\n增长问题先看漏斗：曝光→点击→转化→留存。先找到流失最大的一环，比盲目加预算更有效。',
    description: '精通品牌策略、数字营销、用户增长和内容营销，擅长营销方案制定、渠道选择和ROI分析。',
    knowledge: [
      { subject: '品牌策略框架', source: 'Keller / Ries & Trout《Positioning》', content: 'STP模型（细分/目标/定位）、CBBE品牌资产模型、品牌架构策略、VI设计' },
      { subject: '数字营销体系', source: 'HubSpot / Google Marketing框架', content: 'AARRR漏斗、SEO/SEM关键词策略、小红书/抖音/微信/B站社媒营销、付费广告与A/B测试' },
      { subject: '用户增长方法论', source: 'Sean Ellis《Hacking Growth》', content: '增长循环模型、北极星指标、留存队列分析、Aha Moment识别、A/B测试方法论' },
      { subject: '内容营销体系', source: 'Content Marketing Institute', content: '内容支柱设定、内容矩阵（教育/娱乐/启发/促销）、PAS/AIDA/FAB/4U文案框架、分发策略' },
      { subject: '营销数据分析', source: 'Google Analytics / 归因模型', content: 'CAC/CVR/LTV/NPS核心指标、归因模型（首次/末次/线性/数据驱动）、ROI计算' }
    ],
    capabilities: ['品牌定位与策略制定', '数字营销全案策划', '用户增长方案设计', '内容策略与文案框架', '营销数据分析与ROI评估'],
    constraints: [
      '不做虚假宣传',
      '不侵犯用户隐私',
      '遵守广告法（极限词规避）',
      '不提供刷量/黑产方案',
      '数据来源合法合规'
    ]
  },
  {
    id: 'ui-design-expert',
    name: 'UI设计与动画专家',
    shortName: 'UI 设计',
    hook: '界面土、交互没质感？',
    valueLine: '给你能直接落地的高颜值方案和动效',
    solves: ['改布局', '做动效', '建规范'],
    pains: ['页面看起来不高级，不知道哪里不对', '想要流畅动画但不知道怎么做', '设计稿和开发对不上，没有统一规范'],
    helps: [
      { action: '改界面', desc: '给出布局、配色、字体的具体改法' },
      { action: '做动效', desc: '设计微交互和过渡动画，附 CSS 参数' },
      { action: '建规范', desc: '帮你搭 Design Token 和组件规范' }
    ],
    profession: '资深UI/UX设计师与动效工程师',
    icon: '🎨',
    iconBg: 'rgba(255,77,79,0.1)',
    iconColor: '#ff4d4f',
    category: '04-ProductDesign',
    tags: ['UI设计', '动效设计'],
    quickPrompts: ['这个页面怎么改更好看？', '帮我设计一个按钮 hover 动效', '怎么建立设计系统？'],
    assistantPrefill: '## 结论\n界面质感来自四件事：层次（字号/字重）、留白、一致性（间距/圆角）、以及关键交互的反馈动效。',
    description: '精通UI设计系统、交互设计、动效设计和前端实现，擅长设计规范、微交互和动画方案。',
    knowledge: [
      { subject: '设计系统基础', source: 'Material Design 3 / Apple HIG / Fluent', content: '原子设计方法论、色彩系统（色阶/语义色/暗色模式）、字体系统、间距系统、圆角与阴影层级' },
      { subject: '交互设计原则', source: 'Don Norman / Jakob Nielsen', content: 'Nielsen十大可用性原则、交互模式、响应式设计（断点策略/容器查询）、WCAG 2.2可访问性标准' },
      { subject: '动效设计体系', source: 'Disney动画12原则 / Material Motion', content: '动效12原则适配Web、缓动函数（cubic-bezier参数）、微交互设计模板、动画性能优化（60fps预算）' },
      { subject: '前端实现', source: 'CSS Animation / GSAP / Lottie', content: 'CSS transition/animation、SVG路径动画、GSAP时间轴、Lottie JSON动画、滚动动画（Intersection Observer）' },
      { subject: '设计交付', source: 'Design Tokens / Figma', content: '设计标注规范、Design Tokens（JSON格式）、Figma到代码工作流、组件库搭建' }
    ],
    capabilities: ['UI布局与视觉设计方案', '动效与微交互设计', '设计系统搭建', 'CSS/SVG动画实现', '可访问性审查'],
    constraints: [
      '设计方案考虑可行性',
      '标注精确到像素',
      '动效方案附带性能建议',
      '考虑无障碍访问（WCAG标准）'
    ]
  },
  {
    id: 'ai-prompt-expert',
    name: 'AI提示词工程专家',
    shortName: '提示词',
    hook: 'AI 回答总跑偏、要反复试？',
    valueLine: '帮你一次写对 Prompt，输出稳定可控',
    solves: ['写 Prompt', '搭 Agent', '控输出'],
    pains: ['同样的问题 AI 每次回答不一样', '写了很长的提示词效果还是差', '想做多步骤任务但不知道怎么设计'],
    helps: [
      { action: '优化词', desc: '改你的 Prompt，让输出更准更稳' },
      { action: '搭流程', desc: '设计 Agent 工作流和多步任务拆解' },
      { action: '控格式', desc: '让 AI 稳定输出 JSON、表格等结构化内容' }
    ],
    profession: '资深AI提示词工程师',
    icon: '🤖',
    iconBg: 'rgba(99,102,241,0.1)',
    iconColor: '#6366f1',
    category: '01-WritingEditing',
    tags: ['提示词工程', 'Agent设计'],
    quickPrompts: ['帮我优化这段提示词', '怎么设计一个能自动干活的 Agent？', '怎么让 AI 稳定输出 JSON？'],
    assistantPrefill: '## 结论\n好 Prompt 的三要素：角色+任务边界清晰、输出格式写死、给 1 个正例。缺任何一项都容易跑偏。',
    description: '精通提示词工程、LLM能力边界和链式推理，擅长设计高质量提示词、系统提示和Agent工作流。',
    knowledge: [
      { subject: 'LLM能力与边界', source: 'OpenAI / Anthropic / Google 官方文档', content: '主流模型对比（GPT-4o/Claude 3.5/Gemini/GLM-5/Qwen3/DeepSeek）、上下文窗口管理、能力边界与幻觉问题' },
      { subject: '提示词工程方法论', source: 'OpenAI Prompt Engineering Guide', content: '基础原则（清晰/上下文/分解/示例/角色/格式）、高级技巧（CoT/Self-Consistency/ToT/ReAct/Reflexion）、反模式识别' },
      { subject: '系统提示设计', source: '各模型System Prompt最佳实践', content: '系统提示六层结构、Temperature与采样参数选择、多轮对话管理与摘要策略' },
      { subject: 'Agent与工作流设计', source: 'LangChain / AutoGPT / CrewAI', content: 'ReAct循环、Agent架构模式（单/多/层级/专家）、工作流编排（串行/并行/条件/循环）、RAG系统设计' },
      { subject: '结构化输出', source: 'Function Calling / JSON Schema', content: 'JSON Mode各模型差异、Function Calling函数定义、输出解析验证与错误重试' }
    ],
    capabilities: ['提示词设计与优化', 'Agent架构设计', 'RAG系统方案设计', '模型选型建议', '结构化输出方案设计'],
    constraints: [
      '提示词必须可复现',
      '注明适用模型和版本',
      '考虑安全性和内容过滤',
      '避免过度依赖单一模型',
      '不包含敏感信息（API Key等）'
    ]
  }
];

let currentExpertView = 'list';
let currentExpertId = null;

function openExpertCenter() {
  if (typeof closeSidebar === 'function') closeSidebar();
  closeInspirationLibrary();
  document.getElementById('expertView').classList.add('active');
  document.getElementById('expertSidebarBtn').classList.add('active');
  closeWorkbench();
  renderExpertList();
}

function closeExpertCenter() {
  document.getElementById('expertView')?.classList.remove('active');
  document.getElementById('expertSidebarBtn')?.classList.remove('active');
  currentExpertView = 'list';
  currentExpertId = null;
}

// ============================================================
// Inspiration Library — 灵感库
// ============================================================
const INSPIRE_DB_NAME = 'tangprop-inspire';
const INSPIRE_STORE = 'templates';
const INSPIRE_MAX_FILE_BYTES = 25 * 1024 * 1024;
const INSPIRE_LINKS_KEY = 'tangprop-inspire-custom-links';
const INSPIRE_BUILTIN_LINKS = [
  { id: 'dribbble', name: 'Dribbble', desc: '全球设计师作品与 UI 灵感', url: 'https://dribbble.com/', color: '#ea4c89', letter: 'Dr', logo: 'logos/dribbble.png' },
  { id: 'behance', name: 'Behance', desc: '完整设计项目与品牌案例', url: 'https://www.behance.net/', color: '#1769ff', letter: 'Be', logo: 'logos/behance.png' },
  { id: 'awwwards', name: 'Awwwards', desc: '顶尖网页设计与动效参考', url: 'https://www.awwwards.com/', color: '#111111', letter: 'Aw', logo: 'logos/awwwards.png' },
  { id: 'mobbin', name: 'Mobbin', desc: '移动端真实产品界面库', url: 'https://mobbin.com/', color: '#6c5ce7', letter: 'Mo', logo: 'logos/mobbin.png' },
  { id: 'landbook', name: 'Land-book', desc: '精选落地页与官网灵感', url: 'https://land-book.com/', color: '#00b894', letter: 'Lb', logo: 'logos/landbook.png' },
  { id: 'godly', name: 'Godly', desc: '高质量网站截图收藏', url: 'https://godly.website/', color: '#2d3436', letter: 'Go', logo: 'logos/godly.png' },
  { id: 'refero', name: 'Refero', desc: '按组件检索的网页设计库', url: 'https://refero.design/', color: '#0984e3', letter: 'Re', logo: 'logos/refero.png' },
  { id: 'pinterest', name: 'Pinterest', desc: '视觉氛围板与素材灵感', url: 'https://www.pinterest.com/', color: '#e60023', letter: 'Pi', logo: 'logos/pinterest.png' },
  { id: 'figma', name: 'Figma Community', desc: '免费 UI Kit / 组件库', url: 'https://www.figma.com/community', color: '#a259ff', letter: 'Fi', logo: 'logos/figma.png' },
  { id: 'uimovement', name: 'UI Movement', desc: '交互动效与微交互灵感', url: 'https://uimovement.com/', color: '#00cec9', letter: 'Ui', logo: 'logos/uimovement.png' },
  { id: 'siteinspire', name: 'SiteInspire', desc: '分类清晰的网页设计目录', url: 'https://www.siteinspire.com/', color: '#fdcb6e', letter: 'Si', logo: 'logos/siteinspire.png' },
  { id: 'layer', name: 'Layer', desc: '设计系统与组件灵感', url: 'https://layer.design/', color: '#636e72', letter: 'Ly', logo: 'logos/layer.png' },
];

function inspireLinkDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch (_) {
    return '';
  }
}

/** 网站 logo：内置站用本地抓取图；自定义站用 icon.horse / Google 回退 */
function inspireLinkLogoSources(link) {
  const host = inspireLinkDomain(link && link.url ? link.url : '');
  const local = link && link.logo ? link.logo : '';
  if (local) {
    return {
      primary: local,
      fallback: host ? ('https://icon.horse/icon/' + encodeURIComponent(host)) : '',
    };
  }
  if (!host) return { primary: '', fallback: '' };
  return {
    primary: 'https://icon.horse/icon/' + encodeURIComponent(host),
    fallback: 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(host) + '&sz=256',
  };
}

function inspireLogoOk(img) {
  if (!img) return;
  if (!img.naturalWidth) {
    inspireLogoError(img);
    return;
  }
  img.classList.add('is-ok');
  img.classList.remove('is-fail');
  const brand = img.parentElement && img.parentElement.querySelector('.inspire-link-brand');
  if (brand) brand.classList.add('is-hidden');
}

function inspireLogoError(img) {
  if (!img) return;
  const fb = img.getAttribute('data-fallback');
  if (fb) {
    img.removeAttribute('data-fallback');
    img.src = fb;
    return;
  }
  img.classList.add('is-fail');
  img.classList.remove('is-ok');
}

function hydrateInspireLinkLogos() {
  document.querySelectorAll('.inspire-link-logo').forEach(function(img) {
    if (img.classList.contains('is-ok') || img.classList.contains('is-fail')) return;
    if (img.complete) {
      if (img.naturalWidth > 0) inspireLogoOk(img);
      else inspireLogoError(img);
    }
  });
}

function renderInspireLinkCover(link) {
  const color = escapeHtml(link.color || '#52B6FB');
  const letter = escapeHtml(link.letter || (link.name || '站').slice(0, 2));
  const logos = inspireLinkLogoSources(link || {});
  const primary = escapeHtml(logos.primary || logos.fallback || '');
  const fallback = escapeHtml(logos.fallback || '');
  const img = primary
    ? '<img class="inspire-link-logo" src="' + primary + '" ' +
        (fallback && fallback !== primary ? 'data-fallback="' + fallback + '" ' : '') +
        'alt="' + escapeHtml(link.name || '') + ' logo" loading="eager" decoding="async" referrerpolicy="no-referrer" ' +
        'onload="inspireLogoOk(this)" onerror="inspireLogoError(this)">'
    : '';
  // 封面底色统一白色，logo 白底圆角框展示
  return '<div class="inspire-cover inspire-link-cover" style="--link-color:' + color + ';background-color:#fff;">' +
    '<div class="inspire-link-brand">' + letter + '</div>' +
    img +
  '</div>';
}

let inspireDbPromise = null;
const inspireCoverUrls = new Map();
let inspireMobilePane = 'links'; // links | templates
let inspireCloudCache = []; // 最近一次云端列表（含 meta）
let inspireMigrating = false;
let inspireLinksCache = null;

function inspireUserKey() {
  // 灵感库固定同步桶：避免「已登录用邮箱 / 未登录用 USER_ID」分桶，导致手机看不到电脑模版
  // 登录邮箱仅作辅助别名，真正读写统一走 USER_ID
  return USER_ID || 'guest';
}

function inspireAliasKeys() {
  const keys = [inspireUserKey()];
  if (currentUser) {
    const alt = currentUser.email || currentUser.phone || currentUser.id || currentUser.user_id;
    if (alt && keys.indexOf(String(alt)) < 0) keys.push(String(alt));
  }
  if (keys.indexOf('guest') < 0) keys.push('guest');
  return keys;
}

function inspireApiUrl(path, query, userKey) {
  const q = new URLSearchParams(Object.assign({ user_key: userKey || inspireUserKey() }, query || {}));
  return `${API}/inspire${path}?${q.toString()}`;
}

function normalizeCloudInspireTemplate(item, ownerKey) {
  if (!item || !item.id) return null;
  const id = item.id;
  const key = ownerKey || item._owner_key || inspireUserKey();
  return {
    id: id,
    name: item.name || '未命名模版',
    format: item.format || inspireFileExt(item.name),
    size: item.size || 0,
    type: item.type || 'application/octet-stream',
    createdAt: item.createdAt || 0,
    hasCover: !!item.hasCover,
    cloud: true,
    ownerKey: key,
    coverUrl: item.hasCover ? inspireApiUrl('/templates/' + encodeURIComponent(id) + '/cover', null, key) : '',
    fileUrl: inspireApiUrl('/templates/' + encodeURIComponent(id) + '/file', null, key),
  };
}

async function fetchCloudInspireTemplates() {
  // 后端已合并别名桶；这里再兜底合并，防止旧缓存/旧后端
  const keys = inspireAliasKeys();
  const map = new Map();
  let lastErr = null;
  for (let i = 0; i < keys.length; i++) {
    try {
      const res = await apiFetch(inspireApiUrl('/templates', null, keys[i]));
      if (!res.ok) continue;
      const data = await res.json();
      (data.templates || []).forEach(function(item) {
        const row = normalizeCloudInspireTemplate(item, item._owner_key || keys[i]);
        if (row && !map.has(row.id)) map.set(row.id, row);
      });
    } catch (err) {
      lastErr = err;
    }
  }
  const rows = Array.from(map.values()).sort(function(a, b) {
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
  if (!rows.length && lastErr) throw lastErr;
  inspireCloudCache = rows;
  return rows;
}

async function uploadInspireTemplateToCloud(file, coverDataUrl) {
  const fd = new FormData();
  fd.append('user_key', inspireUserKey());
  fd.append('name', file.name || 'template');
  fd.append('format', inspireFileExt(file.name));
  fd.append('cover_data_url', coverDataUrl || '');
  fd.append('file', file, file.name || 'template.bin');
  const res = await apiFetch(`${API}/inspire/templates`, { method: 'POST', body: fd });
  const data = await res.json().catch(function() { return {}; });
  if (!res.ok) throw new Error(apiErrorDetail(data, '上传失败'));
  return normalizeCloudInspireTemplate(data.template);
}

async function migrateLocalInspireToCloud(cloudRows) {
  if (inspireMigrating) return;
  inspireMigrating = true;
  try {
    const localRows = await listInspireTemplatesLocal();
    if (!localRows.length) return;
    const cloudIds = new Set((cloudRows || []).map(function(x) { return x.id; }));
    // 也用 name+size 去重，避免重复上传
    const cloudSig = new Set((cloudRows || []).map(function(x) {
      return String(x.name || '') + '|' + String(x.size || 0);
    }));
    let uploaded = 0;
    for (let i = 0; i < localRows.length; i++) {
      const item = localRows[i];
      if (!item || !item.data) continue;
      if (cloudIds.has(item.id)) continue;
      const sig = String(item.name || '') + '|' + String(item.size || 0);
      if (cloudSig.has(sig)) continue;
      try {
        const blob = new Blob([item.data], { type: item.type || 'application/octet-stream' });
        const file = new File([blob], item.name || (item.id + '.bin'), {
          type: item.type || 'application/octet-stream',
        });
        await uploadInspireTemplateToCloud(file, item.coverDataUrl || '');
        uploaded += 1;
        cloudSig.add(sig);
      } catch (err) {
        console.warn('[inspire] migrate one failed', item && item.name, err);
      }
    }
    if (uploaded) {
      showToast('已同步 ' + uploaded + ' 个本机模版到云端');
      refreshInspireTemplateList();
    }
  } finally {
    inspireMigrating = false;
  }
}

function openInspirationLibrary() {
  if (typeof closeSidebar === 'function') closeSidebar();
  if (typeof closeExpertCenter === 'function') closeExpertCenter();
  if (typeof closeWorkbench === 'function') closeWorkbench();
  const view = document.getElementById('inspireView');
  if (!view) {
    showToast('灵感库未加载，请刷新页面');
    return;
  }
  view.classList.add('active');
  document.getElementById('inspireSidebarBtn')?.classList.add('active');
  try {
    renderInspirationLibrary();
  } catch (err) {
    console.error('[inspire]', err);
    showToast('灵感库打开失败，请刷新后重试');
  }
}

function switchInspireMobilePane(pane) {
  inspireMobilePane = pane === 'templates' ? 'templates' : 'links';
  const split = document.getElementById('inspireSplit');
  const btnLinks = document.getElementById('inspireMobileTabLinks');
  const btnTpl = document.getElementById('inspireMobileTabTemplates');
  if (split) split.classList.toggle('show-templates', inspireMobilePane === 'templates');
  if (btnLinks) btnLinks.classList.toggle('active', inspireMobilePane === 'links');
  if (btnTpl) btnTpl.classList.toggle('active', inspireMobilePane === 'templates');
  try {
    const body = document.getElementById('inspireBody');
    if (body) body.scrollTop = 0;
  } catch (_) {}
}

function closeInspirationLibrary() {
  closeInspirePreview();
  document.getElementById('inspireView')?.classList.remove('active');
  document.getElementById('inspireSidebarBtn')?.classList.remove('active');
  revokeInspireCoverUrls();
}

function openInspireDb() {
  if (inspireDbPromise) return inspireDbPromise;
  inspireDbPromise = new Promise(function(resolve, reject) {
    const req = indexedDB.open(INSPIRE_DB_NAME, 1);
    req.onupgradeneeded = function() {
      const db = req.result;
      if (!db.objectStoreNames.contains(INSPIRE_STORE)) {
        db.createObjectStore(INSPIRE_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = function() { resolve(req.result); };
    req.onerror = function() { reject(req.error || new Error('IndexedDB 不可用')); };
  });
  return inspireDbPromise;
}

function inspireIdbRequest(mode, runner) {
  return openInspireDb().then(function(db) {
    return new Promise(function(resolve, reject) {
      const tx = db.transaction(INSPIRE_STORE, mode);
      const store = tx.objectStore(INSPIRE_STORE);
      let req;
      try { req = runner(store); }
      catch (err) { reject(err); return; }
      req.onsuccess = function() { resolve(req.result); };
      req.onerror = function() { reject(req.error); };
    });
  });
}

function listInspireTemplatesLocal() {
  return inspireIdbRequest('readonly', function(store) { return store.getAll(); })
    .then(function(rows) {
      return (rows || []).sort(function(a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    });
}

function saveInspireTemplate(record) {
  return inspireIdbRequest('readwrite', function(store) { return store.put(record); });
}

function deleteInspireTemplateLocal(id) {
  return inspireIdbRequest('readwrite', function(store) { return store.delete(id); });
}

function getInspireTemplateLocal(id) {
  return inspireIdbRequest('readonly', function(store) { return store.get(id); });
}

/** 云端优先；失败时回退本机 IndexedDB */
function listInspireTemplates() {
  return fetchCloudInspireTemplates()
    .then(function(rows) {
      // 后台把本机旧模版迁到云端（桌面上传过、手机还看不到时）
      migrateLocalInspireToCloud(rows).catch(function(err) {
        console.warn('[inspire] migrate failed', err);
      });
      return rows;
    })
    .catch(function(err) {
      console.warn('[inspire] cloud list failed, fallback local', err);
      return listInspireTemplatesLocal();
    });
}

async function getInspireTemplate(id) {
  const cached = inspireCloudCache.find(function(x) { return x.id === id; });
  const local = await getInspireTemplateLocal(id).catch(function() { return null; });
  if (local && local.data) {
    return Object.assign({}, cached || {}, local, { cloud: !!(cached && cached.cloud) });
  }
  if (cached && cached.cloud && cached.fileUrl) {
    const res = await apiFetch(cached.fileUrl);
    if (!res.ok) throw new Error('文件不存在');
    const buf = await res.arrayBuffer();
    return Object.assign({}, cached, { data: buf });
  }
  // 缓存未命中时再拉一次列表
  try {
    const rows = await fetchCloudInspireTemplates();
    const hit = rows.find(function(x) { return x.id === id; });
    if (hit && hit.fileUrl) {
      const res = await apiFetch(hit.fileUrl);
      if (!res.ok) throw new Error('文件不存在');
      const buf = await res.arrayBuffer();
      return Object.assign({}, hit, { data: buf });
    }
  } catch (_) {}
  return local || null;
}

function formatInspireSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatInspireDate(ts) {
  try {
    return new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch (_) { return ''; }
}

function inspireFileExt(name) {
  const m = String(name || '').match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toUpperCase() : 'FILE';
}

function inspireTitleFromName(name) {
  const base = String(name || '未命名模版');
  return base.replace(/\.[a-z0-9]+$/i, '') || base;
}

function isInspireImageFile(file) {
  if (!file) return false;
  if (file.type && file.type.startsWith('image/')) return true;
  return /\.(png|jpe?g|webp|gif|svg)$/i.test(file.name || '');
}

function readFileAsArrayBuffer(file) {
  return new Promise(function(resolve, reject) {
    const reader = new FileReader();
    reader.onload = function() { resolve(reader.result); };
    reader.onerror = function() { reject(reader.error || new Error('读取失败')); };
    reader.readAsArrayBuffer(file);
  });
}

function readFileAsDataURL(file) {
  return new Promise(function(resolve, reject) {
    const reader = new FileReader();
    reader.onload = function() { resolve(reader.result); };
    reader.onerror = function() { reject(reader.error || new Error('读取失败')); };
    reader.readAsDataURL(file);
  });
}

function revokeInspireCoverUrls() {
  inspireCoverUrls.forEach(function(url) {
    try { URL.revokeObjectURL(url); } catch (_) {}
  });
  inspireCoverUrls.clear();
}

function inspireCoverSrc(item) {
  if (!item) return '';
  if (item.coverUrl) return item.coverUrl;
  if (item.coverDataUrl) return item.coverDataUrl;
  if (item.coverData && item.coverType) {
    if (inspireCoverUrls.has(item.id)) return inspireCoverUrls.get(item.id);
    const blob = new Blob([item.coverData], { type: item.coverType });
    const url = URL.createObjectURL(blob);
    inspireCoverUrls.set(item.id, url);
    return url;
  }
  // 图片类源文件本身可作为封面
  if (item.data && item.type && String(item.type).startsWith('image/')) {
    if (inspireCoverUrls.has(item.id + '_src')) return inspireCoverUrls.get(item.id + '_src');
    const blob = new Blob([item.data], { type: item.type });
    const url = URL.createObjectURL(blob);
    inspireCoverUrls.set(item.id + '_src', url);
    return url;
  }
  return '';
}

function bindInspireUploadZone() {
  const zone = document.getElementById('inspireUploadZone');
  if (!zone || zone.dataset.bound === '1') return;
  zone.dataset.bound = '1';
  ['dragenter', 'dragover'].forEach(function(ev) {
    zone.addEventListener(ev, function(e) {
      e.preventDefault(); e.stopPropagation();
      zone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach(function(ev) {
    zone.addEventListener(ev, function(e) {
      e.preventDefault(); e.stopPropagation();
      zone.classList.remove('dragover');
      if (ev === 'drop' && e.dataTransfer && e.dataTransfer.files) {
        handleInspireFiles(e.dataTransfer.files);
      }
    });
  });
}

function renderInspirationLibrary() {
  const body = document.getElementById('inspireBody');
  if (!body) return;
  revokeInspireCoverUrls();

  const showTpl = inspireMobilePane === 'templates';
  body.innerHTML =
    '<div class="inspire-page">' +
      '<div class="inspire-page-intro">' +
        '<h2>灵感库</h2>' +
        '<p>左侧直达灵感网站，右侧管理模版源文件。模版会同步到云端，手机与电脑可共用。</p>' +
      '</div>' +
      '<div class="inspire-mobile-seg" role="tablist" aria-label="灵感库分类">' +
        '<button type="button" id="inspireMobileTabLinks" class="' + (showTpl ? '' : 'active') + '" onclick="switchInspireMobilePane(\'links\')">灵感网站</button>' +
        '<button type="button" id="inspireMobileTabTemplates" class="' + (showTpl ? 'active' : '') + '" onclick="switchInspireMobilePane(\'templates\')">模版库</button>' +
      '</div>' +
      '<div class="inspire-split' + (showTpl ? ' show-templates' : '') + '" id="inspireSplit">' +
        '<section class="inspire-pane inspire-pane-links">' +
          '<div class="inspire-block-title"><h3>灵感网站</h3><span>一键直达参考站</span></div>' +
          '<div class="inspire-custom-box">' +
            '<input id="inspireLinkName" type="text" maxlength="40" placeholder="名称，如 Mobbin" enterkeyhint="next">' +
            '<input id="inspireLinkUrl" type="url" inputmode="url" placeholder="https://example.com" enterkeyhint="done">' +
            '<button type="button" onclick="addCustomInspireLink()">添加链接</button>' +
          '</div>' +
          '<div class="inspire-pane-scroll">' +
            '<div class="inspire-card-grid" id="inspireLinkGrid"><div class="inspire-empty">同步中…</div></div>' +
          '</div>' +
        '</section>' +

        '<section class="inspire-pane inspire-pane-templates">' +
          '<div class="inspire-block-title"><h3>灵感模版库</h3><span>云端同步 · 支持封面预览</span></div>' +
          '<div class="inspire-upload-zone" id="inspireUploadZone" onclick="document.getElementById(\'inspireFileInput\').click()">' +
            '<input type="file" id="inspireFileInput" multiple hidden ' +
              'accept=".fig,.sketch,.psd,.ai,.xd,.zip,.rar,.7z,.pdf,.png,.jpg,.jpeg,.webp,.svg,.gif,.html,.css,.json,.figma,image/*" ' +
              'onchange="handleInspireFiles(this.files)">' +
            '<div class="up-icon"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M12 4l-4 4M12 4l4 4"/><path d="M20 16v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2"/></svg></div>' +
            '<div class="up-title">上传模版源文件</div>' +
            '<div class="up-hint">上传后自动同步到云端，手机可直接查看。自动抓取封面。单文件 ≤ 25MB</div>' +
          '</div>' +
          '<div class="inspire-pane-scroll">' +
            '<div class="inspire-card-grid" id="inspireTplGrid"><div class="inspire-empty">同步中…</div></div>' +
          '</div>' +
        '</section>' +
      '</div>' +
    '</div>';

  bindInspireUploadZone();
  switchInspireMobilePane(inspireMobilePane);

  syncCustomInspireLinksFromCloud().then(function(custom) {
    const grid = document.getElementById('inspireLinkGrid');
    if (!grid) return;
    const links = INSPIRE_BUILTIN_LINKS.concat((custom || []).map(function(c) {
      return {
        id: c.id,
        name: c.name,
        desc: c.desc || c.url,
        url: c.url,
        color: c.color || '#52B6FB',
        letter: (c.name || '链').slice(0, 2),
        custom: true,
      };
    }));
    grid.innerHTML = links.map(function(link) {
      const safeId = String(link.id).replace(/'/g, '');
      const del = link.custom
        ? '<div class="inspire-card-actions"><button type="button" onclick="event.preventDefault();event.stopPropagation();removeCustomInspireLink(\'' + safeId + '\')">删除</button></div>'
        : '';
      return '<a class="inspire-big-card is-link" href="' + escapeHtml(link.url) + '" target="_blank" rel="noopener noreferrer">' +
        renderInspireLinkCover(link) +
        '<div class="inspire-card-body">' +
          '<div class="inspire-card-title">' + escapeHtml(link.name) + '</div>' +
          '<div class="inspire-card-sub">' + escapeHtml(link.desc || '') + '</div>' +
          '<div class="inspire-link-go">打开网站 →</div>' +
          del +
        '</div>' +
      '</a>';
    }).join('');
    setTimeout(hydrateInspireLinkLogos, 0);
    setTimeout(hydrateInspireLinkLogos, 300);
  });

  refreshInspireTemplateList();
}

function refreshInspireTemplateList() {
  const grid = document.getElementById('inspireTplGrid');
  if (!grid) return;
  listInspireTemplates().then(function(rows) {
    const meta = document.getElementById('inspireHeaderMeta');
    if (meta) meta.textContent = rows.length + ' 个模版 · ' + (INSPIRE_BUILTIN_LINKS.length + loadCustomInspireLinks().length) + ' 个网站';

    if (!rows.length) {
      grid.innerHTML = '<div class="inspire-empty">还没有云端模版。请在电脑打开灵感库一次（会自动上传本机旧模版），或直接在此上传；上传后手机刷新即可看到。</div>';
      return;
    }
    grid.innerHTML = rows.map(function(item) {
      const safeId = String(item.id).replace(/'/g, '');
      const fmt = escapeHtml(item.format || inspireFileExt(item.name));
      const title = escapeHtml(inspireTitleFromName(item.name));
      const cover = inspireCoverSrc(item);
      const coverHtml = cover
        ? '<img src="' + cover + '" alt="' + title + '" loading="lazy">'
        : '<div class="inspire-cover-fallback"><div class="fmt">' + fmt + '</div><div>暂无封面</div></div>';
      return '<div class="inspire-big-card">' +
        '<div class="inspire-cover" onclick="previewInspireTemplate(\'' + safeId + '\')" title="点击预览">' +
          coverHtml +
          '<span class="inspire-format-badge">' + fmt + '</span>' +
        '</div>' +
        '<div class="inspire-card-body">' +
          '<div class="inspire-card-title" title="' + escapeHtml(item.name || '') + '">' + title + '</div>' +
          '<div class="inspire-card-meta">' +
            '<span class="inspire-chip accent">' + fmt + '</span>' +
            '<span class="inspire-chip">' + escapeHtml(formatInspireSize(item.size)) + '</span>' +
            '<span class="inspire-chip">' + escapeHtml(formatInspireDate(item.createdAt)) + '</span>' +
          '</div>' +
          '<div class="inspire-card-actions">' +
            '<button class="primary" onclick="previewInspireTemplate(\'' + safeId + '\')">预览</button>' +
            '<button onclick="downloadInspireTemplate(\'' + safeId + '\')">下载</button>' +
            '<button onclick="setInspireCover(\'' + safeId + '\')">封面</button>' +
            '<button onclick="removeInspireTemplate(\'' + safeId + '\')">删除</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  }).catch(function(err) {
    grid.innerHTML = '<div class="inspire-empty">读取失败：' + escapeHtml(err && err.message ? err.message : '未知错误') + '</div>';
  });
}

function blobToDataURL(blob) {
  return new Promise(function(resolve, reject) {
    const reader = new FileReader();
    reader.onload = function() { resolve(reader.result); };
    reader.onerror = function() { reject(reader.error || new Error('读取失败')); };
    reader.readAsDataURL(blob);
  });
}

function isLikelyZipBuffer(buf) {
  try {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    return u8.length >= 4 && u8[0] === 0x50 && u8[1] === 0x4b;
  } catch (_) { return false; }
}

/** 压缩封面，避免 IndexedDB 过大 */
function normalizeInspireCoverDataUrl(dataUrl, maxEdge) {
  maxEdge = maxEdge || 1280;
  return new Promise(function(resolve) {
    if (!dataUrl || typeof dataUrl !== 'string') { resolve(''); return; }
    if (dataUrl.indexOf('image/svg') >= 0) { resolve(dataUrl); return; }
    const img = new Image();
    img.onload = function() {
      try {
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        if (!w || !h) { resolve(dataUrl); return; }
        const scale = Math.min(1, maxEdge / Math.max(w, h));
        const cw = Math.max(1, Math.round(w * scale));
        const ch = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, cw, ch);
        ctx.drawImage(img, 0, 0, cw, ch);
        resolve(canvas.toDataURL('image/jpeg', 0.88));
      } catch (_) {
        resolve(dataUrl);
      }
    };
    img.onerror = function() { resolve(dataUrl); };
    img.src = dataUrl;
  });
}

function scoreInspireZipPreviewName(name) {
  const n = String(name || '').replace(/\\/g, '/');
  const base = n.split('/').pop() || '';
  let score = 0;
  if (/^previews\/preview\.(png|jpe?g|webp)$/i.test(n)) score += 1000;
  if (/(^|\/)preview\.(png|jpe?g|webp)$/i.test(n)) score += 800;
  if (/(^|\/)cover\.(png|jpe?g|webp)$/i.test(n)) score += 750;
  if (/(^|\/)thumbnail\.(png|jpe?g|webp)$/i.test(n)) score += 700;
  if (/(^|\/)thumb\.(png|jpe?g|webp)$/i.test(n)) score += 650;
  if (/preview|cover|thumb|海报|封面|效果图/i.test(base)) score += 200;
  if (/\.png$/i.test(base)) score += 30;
  if (/\.(jpe?g|webp)$/i.test(base)) score += 20;
  // 路径越浅越好
  score += Math.max(0, 40 - n.split('/').length * 8);
  // 排除明显非封面
  if (/icon|favicon|logo@|sprite|node_modules|\.git/i.test(n)) score -= 400;
  return score;
}

async function extractCoverFromZipBuffer(buf) {
  if (typeof JSZip === 'undefined') return '';
  const zip = await JSZip.loadAsync(buf);
  const entries = [];
  zip.forEach(function(relativePath, file) {
    if (file.dir) return;
    if (!/\.(png|jpe?g|webp|gif)$/i.test(relativePath)) return;
    entries.push({ name: relativePath, file: file, score: scoreInspireZipPreviewName(relativePath) });
  });
  if (!entries.length) return '';
  entries.sort(function(a, b) { return b.score - a.score; });
  // 取分最高的若干候选，优先能读出的
  for (let i = 0; i < Math.min(entries.length, 8); i++) {
    try {
      const blob = await entries[i].file.async('blob');
      if (!blob || blob.size < 200 || blob.size > 12 * 1024 * 1024) continue;
      const dataUrl = await blobToDataURL(blob);
      const normalized = await normalizeInspireCoverDataUrl(dataUrl, 1280);
      if (normalized) return normalized;
    } catch (_) {}
  }
  return '';
}

async function extractCoverFromPdfBuffer(buf) {
  try {
    const pdfjs = window['pdfjsLib'] || window['pdfjs-dist/build/pdf'];
    if (!pdfjs) return '';
    if (pdfjs.GlobalWorkerOptions) {
      pdfjs.GlobalWorkerOptions.workerSrc =
        'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
    }
    const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const doc = await pdfjs.getDocument({ data: data }).promise;
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 1.25 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: viewport }).promise;
    return await normalizeInspireCoverDataUrl(canvas.toDataURL('image/jpeg', 0.88), 1280);
  } catch (err) {
    console.warn('[inspire] pdf cover failed', err);
    return '';
  }
}

/** 从设计稿自动抓取封面样式 */
async function extractInspireCoverFromDesign(file, buf) {
  if (!file) return '';
  const fmt = inspireFileExt(file.name).toLowerCase();

  // 1) 图片本身即封面
  if (isInspireImageFile(file)) {
    const dataUrl = await readFileAsDataURL(file);
    return normalizeInspireCoverDataUrl(dataUrl, 1280);
  }

  // 2) PDF 渲染首页
  if (fmt === 'pdf' || file.type === 'application/pdf') {
    return extractCoverFromPdfBuffer(buf);
  }

  // 3) Sketch / XD / ZIP / 部分 FIG：按 zip 解包找 preview/cover
  const zipLike = ['sketch', 'zip', 'xd', 'fig', 'sketchpack'].indexOf(fmt) >= 0 || isLikelyZipBuffer(buf);
  if (zipLike) {
    try {
      const cover = await extractCoverFromZipBuffer(buf);
      if (cover) return cover;
    } catch (err) {
      console.warn('[inspire] zip cover failed', err);
    }
  }

  return '';
}

function handleInspireFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  let chain = Promise.resolve();
  let ok = 0;
  let covered = 0;
  showToast('正在上传并同步到云端…');
  files.forEach(function(file) {
    chain = chain.then(function() {
      if (file.size > INSPIRE_MAX_FILE_BYTES) {
        showToast('「' + file.name + '」超过 25MB，已跳过');
        return;
      }
      return readFileAsArrayBuffer(file).then(function(buf) {
        return extractInspireCoverFromDesign(file, buf).then(function(cover) {
          if (cover) covered += 1;
          return uploadInspireTemplateToCloud(file, cover || '').then(function(cloudItem) {
            ok += 1;
            // 本机也留一份，离线可读
            const record = {
              id: (cloudItem && cloudItem.id) || ('tpl_' + Date.now()),
              name: file.name,
              type: file.type || 'application/octet-stream',
              size: file.size,
              format: inspireFileExt(file.name),
              createdAt: (cloudItem && cloudItem.createdAt) || Date.now(),
              data: buf,
              coverDataUrl: cover || '',
            };
            return saveInspireTemplate(record).catch(function() {});
          });
        });
      });
    });
  });
  chain.then(function() {
    if (ok) {
      showToast(covered
        ? ('已同步 ' + ok + ' 个模版到云端，自动抓取封面 ' + covered + ' 个')
        : ('已同步 ' + ok + ' 个模版到云端（未识别到封面，可点「封面」手动设置）'));
    }
    refreshInspireTemplateList();
    const input = document.getElementById('inspireFileInput');
    if (input) input.value = '';
  }).catch(function(err) {
    showToast('上传失败：' + (err && err.message ? err.message : '请重试'));
  });
}

function setInspireCover(id) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml';
  input.onchange = function() {
    const file = input.files && input.files[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      showToast('封面图请控制在 8MB 以内');
      return;
    }
    readFileAsDataURL(file).then(function(dataUrl) {
      return normalizeInspireCoverDataUrl(dataUrl, 1280).then(function(normalized) {
        const cover = normalized || dataUrl;
        const fd = new FormData();
        fd.append('user_key', inspireUserKey());
        fd.append('cover_data_url', cover);
        return apiFetch(`${API}/inspire/templates/${encodeURIComponent(id)}/cover`, {
          method: 'POST',
          body: fd,
        }).then(function(res) {
          return res.json().catch(function() { return {}; }).then(function(data) {
            if (!res.ok) throw new Error(apiErrorDetail(data, '设置封面失败'));
            // 同步更新本机缓存
            return getInspireTemplateLocal(id).then(function(local) {
              if (local) {
                local.coverDataUrl = cover;
                local.coverType = file.type || 'image/jpeg';
                return saveInspireTemplate(local);
              }
            }).catch(function() {}).then(function() {
              showToast('封面已更新并同步');
              refreshInspireTemplateList();
            });
          });
        });
      });
    }).catch(function(err) {
      showToast('设置封面失败：' + (err && err.message ? err.message : ''));
    });
  };
  input.click();
}

let inspirePreviewObjectUrl = '';

function inspirePreviewKind(item) {
  const fmt = String(item.format || inspireFileExt(item.name) || '').toLowerCase();
  const type = String(item.type || '').toLowerCase();
  if (type.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].indexOf(fmt) >= 0) return 'image';
  if (type === 'application/pdf' || fmt === 'pdf') return 'pdf';
  if (type === 'text/html' || fmt === 'html' || fmt === 'htm') return 'html';
  if (
    type.startsWith('text/') ||
    ['css', 'js', 'json', 'md', 'txt', 'svg', 'xml', 'csv'].indexOf(fmt) >= 0
  ) return 'text';
  return 'binary';
}

function closeInspirePreview() {
  const overlay = document.getElementById('inspirePreviewOverlay');
  const body = document.getElementById('inspirePreviewBody');
  if (overlay) overlay.classList.remove('open');
  if (body) body.innerHTML = '';
  if (inspirePreviewObjectUrl) {
    try { URL.revokeObjectURL(inspirePreviewObjectUrl); } catch (_) {}
    inspirePreviewObjectUrl = '';
  }
  const btn = document.getElementById('inspirePreviewDownloadBtn');
  if (btn) btn.onclick = null;
}

document.addEventListener('keydown', function(e) {
  if (e.key !== 'Escape') return;
  const overlay = document.getElementById('inspirePreviewOverlay');
  if (overlay && overlay.classList.contains('open')) closeInspirePreview();
});

function previewInspireTemplate(id) {
  getInspireTemplate(id).then(function(item) {
    if (!item || !item.data) { showToast('文件不存在'); return; }
    closeInspirePreview();

    const overlay = document.getElementById('inspirePreviewOverlay');
    const body = document.getElementById('inspirePreviewBody');
    const titleEl = document.getElementById('inspirePreviewTitle');
    const metaEl = document.getElementById('inspirePreviewMeta');
    const dlBtn = document.getElementById('inspirePreviewDownloadBtn');
    if (!overlay || !body) return;

    const fmt = item.format || inspireFileExt(item.name);
    const kind = inspirePreviewKind(item);
    if (titleEl) titleEl.textContent = inspireTitleFromName(item.name);
    if (metaEl) {
      metaEl.textContent = (item.name || '') + ' · ' + fmt + ' · ' + formatInspireSize(item.size);
    }
    if (dlBtn) dlBtn.onclick = function() { downloadInspireTemplate(id); };

    const mime = item.type || (
      kind === 'pdf' ? 'application/pdf' :
      kind === 'html' ? 'text/html' :
      kind === 'image' ? 'image/*' :
      'application/octet-stream'
    );
    const blob = new Blob([item.data], { type: mime });
    inspirePreviewObjectUrl = URL.createObjectURL(blob);

    if (kind === 'image') {
      body.innerHTML = '<img src="' + inspirePreviewObjectUrl + '" alt="' + escapeHtml(item.name || 'preview') + '">';
    } else if (kind === 'pdf') {
      body.innerHTML = '<iframe src="' + inspirePreviewObjectUrl + '#toolbar=1" title="PDF 预览"></iframe>';
    } else if (kind === 'html') {
      body.innerHTML = '<iframe src="' + inspirePreviewObjectUrl + '" sandbox="allow-same-origin" title="HTML 预览"></iframe>';
    } else if (kind === 'text') {
      try {
        const text = new TextDecoder('utf-8').decode(item.data instanceof ArrayBuffer ? item.data : new Uint8Array(item.data));
        body.innerHTML = '<pre></pre>';
        body.querySelector('pre').textContent = text;
      } catch (_) {
        body.innerHTML = '<div class="inspire-preview-fallback"><p>无法以文本方式预览该文件</p></div>';
      }
    } else {
      const cover = inspireCoverSrc(item);
      body.innerHTML =
        '<div class="inspire-preview-fallback">' +
          (cover ? '<img src="' + cover + '" alt="cover">' : '') +
          '<p>浏览器暂不支持直接打开 .' + escapeHtml(String(fmt).toLowerCase()) +
          ' 源文件。可预览封面，或下载后用对应设计软件打开。</p>' +
          '<button class="primary" type="button" onclick="downloadInspireTemplate(\'' + String(id).replace(/'/g, '') + '\')" ' +
            'style="min-height:38px;padding:0 16px;border:none;border-radius:10px;background:#fff;color:#111;font-weight:700;cursor:pointer;font-family:var(--font);">下载源文件</button>' +
        '</div>';
    }

    overlay.classList.add('open');
  }).catch(function() { showToast('预览失败'); });
}

function downloadInspireTemplate(id) {
  getInspireTemplate(id).then(function(item) {
    if (!item || !item.data) { showToast('文件不存在'); return; }
    const blob = new Blob([item.data], { type: item.type || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = item.name || 'template';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function() { URL.revokeObjectURL(url); }, 1500);
  }).catch(function() { showToast('下载失败'); });
}

function removeInspireTemplate(id) {
  if (!confirm('确定删除这个模版源文件？')) return;
  apiFetch(inspireApiUrl('/templates/' + encodeURIComponent(id)), { method: 'DELETE' })
    .then(function(res) {
      if (!res.ok) throw new Error('删除失败');
      return deleteInspireTemplateLocal(id).catch(function() {});
    })
    .then(function() {
      showToast('已删除（已同步）');
      refreshInspireTemplateList();
    })
    .catch(function() {
      // 云端失败时仍尝试删本机
      deleteInspireTemplateLocal(id).then(function() {
        showToast('已删除本机副本');
        refreshInspireTemplateList();
      }).catch(function() { showToast('删除失败'); });
    });
}

function loadCustomInspireLinksLocal() {
  try {
    const raw = localStorage.getItem(INSPIRE_LINKS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}

function saveCustomInspireLinksLocal(list) {
  localStorage.setItem(INSPIRE_LINKS_KEY, JSON.stringify(list || []));
  inspireLinksCache = list || [];
}

function loadCustomInspireLinks() {
  if (Array.isArray(inspireLinksCache)) return inspireLinksCache;
  return loadCustomInspireLinksLocal();
}

async function syncCustomInspireLinksFromCloud() {
  try {
    const res = await apiFetch(inspireApiUrl('/links'));
    if (!res.ok) throw new Error('links fetch failed');
    const data = await res.json();
    const cloud = Array.isArray(data.links) ? data.links : [];
    const local = loadCustomInspireLinksLocal();
    // 合并：以 id 去重，云端优先，再补本地独有
    const map = new Map();
    cloud.forEach(function(x) { if (x && x.id) map.set(x.id, x); });
    local.forEach(function(x) {
      if (x && x.id && !map.has(x.id)) map.set(x.id, x);
    });
    const merged = Array.from(map.values());
    saveCustomInspireLinksLocal(merged);
    // 若本地有云端没有的，写回云端
    const cloudIds = new Set(cloud.map(function(x) { return x.id; }));
    const needPush = merged.some(function(x) { return !cloudIds.has(x.id); }) || cloud.length !== merged.length;
    if (needPush) {
      await apiFetch(`${API}/inspire/links`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_key: inspireUserKey(), links: merged }),
      });
    }
    return merged;
  } catch (err) {
    console.warn('[inspire] links sync failed', err);
    return loadCustomInspireLinksLocal();
  }
}

async function saveCustomInspireLinks(list) {
  saveCustomInspireLinksLocal(list);
  try {
    const res = await apiFetch(`${API}/inspire/links`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_key: inspireUserKey(), links: list || [] }),
    });
    if (!res.ok) throw new Error('save links failed');
  } catch (err) {
    console.warn('[inspire] links push failed', err);
  }
}

function addCustomInspireLink() {
  const nameEl = document.getElementById('inspireLinkName');
  const urlEl = document.getElementById('inspireLinkUrl');
  const name = (nameEl && nameEl.value || '').trim();
  let url = (urlEl && urlEl.value || '').trim();
  if (!name || !url) { showToast('请填写名称和链接'); return; }
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try { new URL(url); } catch (_) { showToast('链接格式不正确'); return; }
  const list = loadCustomInspireLinks().slice();
  list.unshift({
    id: 'custom_' + Date.now(),
    name: name,
    url: url,
    desc: '自定义灵感链接',
    color: '#52B6FB',
  });
  saveCustomInspireLinks(list).then(function() {
    showToast('已添加链接（已同步）');
    renderInspirationLibrary();
  });
}

function removeCustomInspireLink(id) {
  const next = loadCustomInspireLinks().filter(function(x) { return x.id !== id; });
  saveCustomInspireLinks(next).then(function() {
    showToast('已删除链接（已同步）');
    renderInspirationLibrary();
  });
}

// 暴露到 window，避免移动端缓存/内联事件找不到函数
window.openInspirationLibrary = openInspirationLibrary;
window.closeInspirationLibrary = closeInspirationLibrary;
window.switchInspireMobilePane = switchInspireMobilePane;
window.previewInspireTemplate = previewInspireTemplate;
window.downloadInspireTemplate = downloadInspireTemplate;
window.setInspireCover = setInspireCover;
window.removeInspireTemplate = removeInspireTemplate;
window.handleInspireFiles = handleInspireFiles;
window.addCustomInspireLink = addCustomInspireLink;
window.removeCustomInspireLink = removeCustomInspireLink;
window.closeInspirePreview = closeInspirePreview;
window.inspireLogoOk = inspireLogoOk;
window.inspireLogoError = inspireLogoError;

function goHome() {
  closeWorkbench();
  closeExpertCenter();
  closeInspirationLibrary();
  closeAllDropdowns();
  closeSettings();
  state.inChat = false;
  state.activeScene = null;
  state.loading = false;
  state.draftAgent = false;
  state.pendingExpert = null;
  const input = document.getElementById('userInput');
  if (input) {
    input.value = '';
    autoResize(input);
  }
  renderInputTags();
  renderExpertTags(null);
  updateInputMode();
  if (typeof closeSidebar === 'function') closeSidebar();
  else document.getElementById('sidebar')?.classList.remove('open');
  renderChatPreviewEmpty();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function expertIconSvg(icon) {
  const map = {
    '💰': '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
    '⚖️': '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="3" x2="12" y2="21"/><path d="M3 7h18M6 7l-3 6h6zM18 7l-3 6h6z"/><path d="M3 21h18"/></svg>',
    '💻': '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
    '📈': '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>',
    '🎨': '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r="2.5"/><circle cx="17" cy="14" r="2.5"/><circle cx="8" cy="12" r="2.5"/><path d="M15.5 7.5l-5.5 3M14.5 15.5l-5-3"/></svg>',
    '🤖': '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/></svg>'
  };
  return map[icon] || '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg>';
}

function renderExpertList() {
  currentExpertView = 'list';
  currentExpertId = null;
  const body = document.getElementById('expertBody');
  const cards = EXPERTS_DATA.map(function(expert) {
    const title = expert.shortName || expert.name;
    const hook = expert.hook || '';
    const solves = (expert.solves || []).slice(0, 3);
    const example = expert.quickPrompts && expert.quickPrompts[0] ? expert.quickPrompts[0] : '';
    const solveTags = solves.map(function(s) {
      return '<span class="card-solve-tag">' + s + '</span>';
    }).join('');
    return '<div class="expert-card" onclick="showExpertDetail(\'' + expert.id + '\')">' +
      '<div class="card-top">' +
        '<div class="card-icon" style="background:' + expert.iconBg + ';color:' + expert.iconColor + ';">' + expertIconSvg(expert.icon) + '</div>' +
        '<div class="card-info"><div class="card-name">' + title + '</div></div>' +
      '</div>' +
      '<div class="card-hook">' + hook + '</div>' +
      '<div class="card-solves">' + solveTags + '</div>' +
      (example ? '<div class="card-example" onclick="event.stopPropagation();useExpertPrompt(\'' + expert.id + '\',0)"><span>试试</span>' + example + '</div>' : '') +
      '<div class="card-action">了解详情 →</div>' +
    '</div>';
  }).join('');

  body.innerHTML =
    '<div style="width:100%;margin:0 0 24px;">' +
      '<h2 style="font-size:22px;font-weight:800;color:var(--text);margin-bottom:8px;">遇到什么问题？</h2>' +
      '<p style="font-size:14px;color:var(--text-secondary);line-height:1.5;">选一个专家，3 秒看懂能帮你什么</p>' +
    '</div>' +
    '<div class="expert-grid">' + cards + '</div>';
  body.scrollTop = 0;
}

function showExpertDetail(expertId) {
  currentExpertView = 'detail';
  currentExpertId = expertId;
  var expert = EXPERTS_DATA.find(function(e) { return e.id === expertId; });
  if (!expert) return;

  var body = document.getElementById('expertBody');
  var pains = (expert.pains || []).map(function(p) { return '<li>' + p + '</li>'; }).join('');
  var helps = (expert.helps || []).map(function(h) {
    return '<li><strong>' + h.action + '</strong>' + h.desc + '</li>';
  }).join('');
  var qpFallback = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  var quickPromptsHtml = expert.quickPrompts.map(function(q, i) {
    return '<div class="expert-quick-prompt" onclick="useExpertPrompt(\'' + expert.id + '\', ' + i + ')">' +
      '<div class="qp-icon">' + qpFallback + '</div><span>' + q + '</span></div>';
  }).join('');

  body.innerHTML =
    '<div class="expert-detail">' +
      '<button class="detail-back" onclick="renderExpertList()">← 返回专家列表</button>' +
      '<div class="detail-header">' +
        '<div class="detail-icon" style="background:' + expert.iconBg + ';color:' + expert.iconColor + ';">' + expertIconSvg(expert.icon) + '</div>' +
        '<div class="detail-info">' +
          '<div class="detail-name">' + (expert.shortName || expert.name) + '</div>' +
          '<div class="detail-hook">' + (expert.valueLine || expert.hook || expert.description) + '</div>' +
          '<div class="detail-tags">' +
            expert.tags.map(function(t) { return '<span class="detail-tag">' + t + '</span>'; }).join('') +
          '</div>' +
        '</div>' +
      '</div>' +
      (pains ? '<div class="expert-pain-block"><div class="expert-block-title"><span class="emoji">😰</span>你是不是遇到…</div><ul class="expert-pain-list">' + pains + '</ul></div>' : '') +
      (helps ? '<div class="expert-help-block"><div class="expert-block-title"><span class="emoji">✅</span>我可以帮你…</div><ul class="expert-help-list">' + helps + '</ul></div>' : '') +
      '<div class="expert-block-title"><span class="emoji">💬</span>试试这样问</div>' +
      '<div class="expert-quick-prompts">' + quickPromptsHtml + '</div>' +
      '<div class="expert-detail-cta">' +
        '<p>准备好了？点下面直接开聊</p>' +
        '<button onclick="startExpertChat(\'' + expert.id + '\')">开始对话</button>' +
      '</div>' +
    '</div>';
  body.scrollTop = 0;
}

function useExpertPrompt(expertId, promptIndex) {
  var expert = EXPERTS_DATA.find(function(e) { return e.id === expertId; });
  if (!expert) return;
  startExpertChat(expertId, expert.quickPrompts[promptIndex]);
}

function buildExpertSystemContext(expert) {
  var helps = (expert.helps || []).map(function(h) {
    return '- **' + h.action + '**：' + h.desc;
  }).join('\n');
  if (!helps) {
    helps = (expert.capabilities || []).map(function(c) { return '- ' + c; }).join('\n');
  }
  var constraints = (expert.constraints || []).map(function(c) { return '- ' + c; }).join('\n');
  var knowledgeBrief = (expert.knowledge || []).map(function(k) {
    return '- ' + k.subject + '（' + k.source + '）：' + k.content;
  }).join('\n');

  return (
    '## 专家身份\n' +
    '你是「' + expert.name + '」，' + expert.profession + '。\n' +
    (expert.valueLine ? '核心价值：' + expert.valueLine + '\n' : '') +
    (expert.outputGuide ? '场景指引：' + expert.outputGuide + '\n' : '') +
    (expert.fewShot ? '\n## 回复示例（必须照此风格：先框架后追问）\n' + expert.fewShot + '\n' : '') +
    '\n## 回复格式（必须遵守，违反视为失败）\n' +
    '1. **结论先行**：第一句必须是明确判断、框架或建议，禁止以「当然可以」「好的」「我需要更多信息」「无法给出结论」开头。\n' +
    '2. **结构化输出**：用 Markdown 分节，至少包含「## 结论」和「## 建议」；复杂问题加「## 分析要点」。\n' +
    '3. **信息不足时**：结论里也要给出通用框架（如「是否值得买取决于估值/盈利/护城河/风险/仓位五维」），禁止写「无法分析」；然后再给分析要点，最后最多追问 1 个问题。\n' +
    '4. **可执行**：每条回复至少给出 1 个用户能直接使用的判断、步骤、公式或清单项。\n' +
    '5. **不要调用工具拖延**：优先用专业知识直接回答；仅当用户已给出具体标的且明确需要最新行情/新闻时才用 web_search。\n' +
    '6. 中文回答，专业但易懂，避免空泛套话。\n' +
    '\n## 你能帮用户解决\n' + helps + '\n' +
    '\n## 专业约束\n' + constraints + '\n' +
    '\n## 知识基础（内化运用，不要原样罗列给用户）\n' + knowledgeBrief
  );
}

function startExpertChat(expertId, presetPrompt) {
  var expert = EXPERTS_DATA.find(function(e) { return e.id === expertId; });
  if (!expert) return;
  closeExpertCenter();
  var expertContext = buildExpertSystemContext(expert);
  state.pendingExpert = {
    expertId: expertId,
    expertContext: expertContext,
    title: (expert.shortName || expert.name) + ' · ' + (presetPrompt ? presetPrompt.slice(0, 12) : '咨询')
  };
  state.autoMode = true;
  state.selectedProvider = null;
  state.selectedModel = null;
  state.draftAgent = false;
  state.inChat = false;
  state.activeScene = null;
  closeWorkbench();
  renderTasks();
  updateInputMode();
  var input = document.getElementById('userInput');
  if (presetPrompt) { input.value = presetPrompt; autoResize(input); autoDetectModel(); } else { input.value = ''; }
  renderExpertTags(expert);
  input.focus();
}

function renderExpertTags(expert) {
  var tagsContainer = document.getElementById('inputTags');
  if (!tagsContainer) return;
  if (expert) {
    tagsContainer.innerHTML = '<span style="background:' + expert.iconBg + ';color:' + expert.iconColor + ';font-size:12px;padding:3px 10px;border-radius:20px;display:inline-flex;align-items:center;gap:4px;">' + expertIconSvg(expert.icon) + ' ' + (expert.shortName || expert.name) + '</span>';
  } else {
    tagsContainer.innerHTML = '';
  }
}

/* ---- Clear chat ---- */
function clearWbChat() {
  const thread = document.getElementById('wbChatThread');
  if (!thread) return;
  thread.innerHTML = '';
  thread.dataset.demoRan = '';
  thread.dataset.seeded = '';
  if (!state.draftAgent) {
    const conv = state.conversations.find(c => c.id === state.activeConv && c.isAgent);
    if (conv) {
      conv.messages = [];
      conv.time = '刚刚';
      saveConversations();
      renderTasks();
    }
  }
  addWbThreadMsg({
    role: 'agent',
    text: '你好！告诉我你想做什么 —— 例如「做一个苹果风格的首页」「给我画一个登录卡片」「设计一个数据看板」。'
  });
  thread.dataset.seeded = 'true';
  renderWbEmpty();
}

/* ---- Reset ---- */
function resetWorkbench() {
  if (wbDemoTimer) clearTimeout(wbDemoTimer);
  const thread = document.getElementById('wbChatThread');
  if (thread) { thread.dataset.demoRan = ''; thread.dataset.seeded = ''; thread.innerHTML = ''; }
  renderWbEmpty();
  state.draftAgent = true;
  const titleEl = document.getElementById('wbTaskTitle');
  if (titleEl) titleEl.textContent = '新任务';
  renderTasks();
  openWorkbench();
}

/* ---- Demo: stream chat messages → preview ---- */
function runWorkbenchDemo() {
  if (wbDemoTimer) clearTimeout(wbDemoTimer);
  const thread = document.getElementById('wbChatThread');
  if (!thread) { renderWbPreview(); return; }
  thread.dataset.demoRan = 'true';
  thread.innerHTML = '';

  let i = 0;
  function nextMsg() {
    if (i >= WB_CHAT_DEMO.length) {
      const html = getWbPreviewHtml();
      pushPreviewHistory(html);
      renderWbPreview(html);
      return;
    }
    addWbThreadMsg(WB_CHAT_DEMO[i]);
    i++;
    wbDemoTimer = setTimeout(nextMsg, i === 1 ? 600 : 1600);
  }
  nextMsg();
}

function addWbThreadMsg(msg) {
  const thread = document.getElementById('wbChatThread');
  if (!thread) return;
  const div = document.createElement('div');
  div.className = 'wb-thread-msg ' + msg.role;
  const author = msg.role === 'user' ? '你' : 'Agent';
  const avatarSvg = msg.role === 'user'
    ? `<span style="font-size:12px;font-weight:700;">T</span>`
    : `<img src="pupu-avatar.jpg" style="width:100%;height:100%;object-fit:cover;border-radius:8px;" alt="PUPU">`;

  const toolIconSvg = (icon) => {
    if (icon === '🔍') return `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;
    if (icon === '📄') return `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
    if (icon === '🤖') return `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/></svg>`;
    if (icon === '💡') return `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/></svg>`;
    if (icon === '⚡') return `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`;
    if (icon === '💻') return `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`;
    if (icon === '🎨') return `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r="2.5"/><circle cx="17" cy="14" r="2.5"/><circle cx="8" cy="12" r="2.5"/><path d="M15.5 7.5l-5.5 3M14.5 15.5l-5-3"/></svg>`;
    return `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg>`;
  };

  let extra = '';
  if (msg.thinking) {
    extra += `<div class="wb-thinking-block"><span>${escapeHtml(msg.thinking)}</span><span class="pulse-dot"></span></div>`;
  }
  if (msg.tools && msg.tools.length) {
    extra += msg.tools.map(t =>
      `<div class="wb-tool-call">${toolIconSvg(t.icon)} ${t.text}</div>`
    ).join('');
  }

  const content = msg.role === 'user'
    ? escapeHtml(msg.text)
    : formatContent(msg.text) + extra;

  div.innerHTML = `
    <div class="wb-thread-avatar">${avatarSvg}</div>
    <div class="wb-thread-body">
      <div class="wb-thread-author">${author}</div>
      <div class="wb-thread-bubble">${content}</div>
    </div>
  `;
  thread.appendChild(div);
  thread.scrollTop = thread.scrollHeight;
}

/* ---- Preview ---- */
let currentWbHtml = '';
let wbPreviewHistory = [];
let wbPreviewIndex = -1;

function pushPreviewHistory(html) {
  if (wbPreviewIndex < wbPreviewHistory.length - 1) {
    wbPreviewHistory = wbPreviewHistory.slice(0, wbPreviewIndex + 1);
  }
  wbPreviewHistory.push(html);
  wbPreviewIndex = wbPreviewHistory.length - 1;
}

function wbPreviewBack() {
  if (wbPreviewIndex > 0) {
    wbPreviewIndex--;
    renderWbPreview(wbPreviewHistory[wbPreviewIndex], true);
  } else {
    showToast('没有更早的预览');
  }
}

function wbPreviewForward() {
  if (wbPreviewIndex < wbPreviewHistory.length - 1) {
    wbPreviewIndex++;
    renderWbPreview(wbPreviewHistory[wbPreviewIndex], true);
  } else {
    showToast('没有更新的预览');
  }
}

function renderWbPreview(html, quiet = false) {
  const useHtml = html || getWbPreviewHtml();
  currentWbHtml = useHtml;
  const frame = document.getElementById('wbPreviewFrame');
  frame.innerHTML = `<iframe id="wbPreviewIframe" sandbox="allow-scripts allow-same-origin"></iframe>`;
  const iframe = document.getElementById('wbPreviewIframe');
  iframe.contentDocument.open();
  iframe.contentDocument.write(useHtml);
  iframe.contentDocument.close();
  if (!quiet) showToast('预览已渲染');
}

function renderWbFromHtml(html) {
  pushPreviewHistory(html);
  renderWbPreview(html, true);
}

function openPreviewNewTab() {
  const html = currentWbHtml || getWbPreviewHtml();
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
}

function setPreviewSize(btn, width) {
  document.querySelectorAll('.wb-browser-actions .wb-nav-btn').forEach(b => {
    if (['桌面', '平板', '手机'].includes(b.title)) b.classList.remove('active');
  });
  btn.classList.add('active');
  const iframe = document.getElementById('wbPreviewIframe');
  if (iframe) iframe.style.width = width;
}

function reloadPreview() {
  if (currentWbHtml) {
    renderWbPreview(currentWbHtml);
    showToast('已刷新');
  } else {
    renderWbEmpty();
  }
}

/* ---- Chat Input ---- */
function autoResizeWbInput(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 100) + 'px';
}

function handleWbKey(e) {
  const palette = document.getElementById('commandPalette');
  if (palette?.classList.contains('open')) {
    handleCommandKey(e, e.target);
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendWbMessage();
  }
}

// ── Workbench Auto 模型匹配（复用首页 AUTO_RULES）──
function wbAutoDetect() {
  const input = document.getElementById('wbChatInput');
  if (!input) return;
  const text = input.value.trim();
  const badge = document.getElementById('wbModelName');
  const inline = document.getElementById('wbModelNameInline');
  const targets = [badge, inline].filter(Boolean);
  if (!targets.length) return;

  const setLabel = (label, title) => {
    targets.forEach(el => {
      el.textContent = label;
      const host = el.closest('.wb-model-badge, .model-selector');
      if (host) host.title = title;
    });
  };

  if (!text) { setLabel('Auto', '输入后自动匹配模型'); return; }
  if (!state.providers || !state.providers.length) { setLabel('Auto', '自动匹配模型'); return; }
  const matched = matchModel(text, estimateComplexity(text), null);
  if (matched) {
    const label = matched.reason ? 'Auto · ' + matched.reason : (matched.name || matched.model);
    setLabel(label, 'Auto → ' + matched.provider + '/' + matched.model);
  } else {
    setLabel('Auto', '自动匹配模型');
  }
}

function wbResolveModel(text) {
  if (!state.providers || !state.providers.length) return {};
  const matched = matchModel(text, estimateComplexity(text), null);
  if (matched) return { provider: matched.provider, model: matched.model, reason: matched.reason };
  return {};
}

async function sendWbMessage() {
  const input = document.getElementById('wbChatInput');
  if (!input) return;
  const text = input.value.trim();
  if (!text || input.disabled) return;

  const conv = ensureAgentTask(text);
  conv.messages.push({ role: 'user', content: text });
  conv.time = '刚刚';
  saveConversations();

  // 1) 立刻把用户消息渲染到左侧对话线程
  addWbThreadMsg({ role: 'user', text });
  input.value = '';
  input.style.height = 'auto';
  input.disabled = true;
  const sendBtn = document.getElementById('wbSendBtn');
  if (sendBtn) sendBtn.disabled = true;

  // 2) 创建 pending agent 气泡（带"思考中"badge）
  const pending = createWbPending();
  let fullText = '';
  let previewRendered = false;

  // 3) Auto 匹配模型
  const { provider: wbProvider, model: wbModel } = wbResolveModel(text);

  // 4) 流式调 /workbench/run
  try {
    const wbPayload = { message: text, provider: wbProvider, model: wbModel };
    if (state.maxMode) { wbPayload.max_tokens = 32768; wbPayload.max_turns = 50; }
    const res = await apiFetch(`${API}/workbench/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(wbPayload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(apiErrorDetail(err, `请求失败 (${res.status})`));
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const chunk = JSON.parse(trimmed);
          if (chunk.type === 'status') {
            updateWbBadge(pending, chunk.state === 'done' ? '已完成' : '思考中…');
          } else if (chunk.type === 'text') {
            fullText += chunk.delta || chunk.content || '';
            updateWbPendingText(pending, fullText);
          } else if (chunk.type === 'preview_html' && chunk.html) {
            renderWbFromHtml(chunk.html);
            previewRendered = true;
            updateWbBadge(pending, '预览已更新');
          } else if (chunk.type === 'tool_call') {
            updateWbBadge(pending, `调用工具 · ${chunk.name || ''}`);
          } else if (chunk.type === 'error') {
            throw new Error(chunk.message || '模型返回错误');
          }
        } catch (e) {
          // 跳过解析失败的行
          if (!(e instanceof SyntaxError)) throw e;
        }
      }
    }

    // 流结束：把 pending 转成正式气泡
    const finalText = fullText || (previewRendered ? '（已生成右侧预览）' : '已完成');
    finalizeWbPending(pending, finalText);
    conv.messages.push({ role: 'assistant', content: finalText });
    conv.time = '刚刚';
    saveConversations();
    renderTasks();
    if (!previewRendered) {
      // 模型没返回代码块 → 至少给个提示
      showToast('模型本次未返回预览代码');
    }
  } catch (e) {
    const errText = `错误: ${e.message}`;
    finalizeWbPending(pending, errText, true);
    conv.messages.push({ role: 'assistant', content: errText });
    conv.time = '刚刚';
    saveConversations();
    renderTasks();
  } finally {
    input.disabled = false;
    if (sendBtn) sendBtn.disabled = false;
    input.focus();
  }
}

/* ---- Pending bubble helpers ---- */
function createWbPending() {
  const thread = document.getElementById('wbChatThread');
  if (!thread) return null;
  const div = document.createElement('div');
  div.className = 'wb-thread-msg agent pending';
  div.innerHTML = `
    <div class="wb-thread-avatar"><img src="pupu-avatar.jpg" style="width:100%;height:100%;object-fit:cover;border-radius:8px;" alt="PUPU"></div>
    <div class="wb-thread-body">
      <div class="wb-thread-author">Agent</div>
      <div class="wb-thread-bubble">
        <span class="wb-reasoning-badge"><span class="pulse-dot"></span>思考中…</span>
        <div class="wb-pending-text"></div>
      </div>
    </div>
  `;
  thread.appendChild(div);
  thread.scrollTop = thread.scrollHeight;
  return div;
}

function updateWbBadge(node, label) {
  if (!node) return;
  const badge = node.querySelector('.wb-reasoning-badge');
  if (badge) badge.innerHTML = `<span class="pulse-dot"></span>${escapeHtml(label)}`;
}

function updateWbPendingText(node, text) {
  if (!node) return;
  const box = node.querySelector('.wb-pending-text');
  if (box) box.innerHTML = formatContent(text);
  const thread = document.getElementById('wbChatThread');
  if (thread) thread.scrollTop = thread.scrollHeight;
}

function finalizeWbPending(node, text, isError) {
  if (!node) return;
  node.classList.remove('pending');
  const bubble = node.querySelector('.wb-thread-bubble');
  if (!bubble) return;
  bubble.innerHTML = isError
    ? `<span style="color:var(--danger)">${escapeHtml(text)}</span>`
    : formatContent(text);
}

/* ---- Empty preview ---- */
function renderWbEmpty() {
  const frame = document.getElementById('wbPreviewFrame');
  if (!frame) return;
  frame.innerHTML = `
    <div class="wb-empty" style="width:100%;">
      <div class="big-icon"><svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg></div>
      <div>浏览器预览窗口</div>
      <div style="font-size:12px;margin-top:4px;">Agent 生成的页面将在这里实时展示</div>
    </div>
  `;
}

/* ---- Chat Preview（新任务对话 · 右侧预览）---- */
let currentChatHtml = '';
let chatPreviewHistory = [];
let chatPreviewIndex = -1;

function extractHtmlFromMarkdown(text) {
  if (!text) return null;
  let m = text.match(/```html\s*([\s\S]*?)```/i);
  if (m) return m[1].trim();
  m = text.match(/```\s*(<!DOCTYPE[\s\S]*?<\/html>[\s\S]*?)```/i);
  if (m) return m[1].trim();
  m = text.match(/```html\s*([\s\S]+)$/i);
  if (m && /<[a-z]/i.test(m[1])) return m[1].trim();
  const trimmed = text.trim();
  if (/^<!DOCTYPE html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) return trimmed;
  return null;
}

function pushChatPreviewHistory(html) {
  if (chatPreviewIndex < chatPreviewHistory.length - 1) {
    chatPreviewHistory = chatPreviewHistory.slice(0, chatPreviewIndex + 1);
  }
  chatPreviewHistory.push(html);
  chatPreviewIndex = chatPreviewHistory.length - 1;
}

function isMobileChatLayout() {
  return typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 768px)').matches;
}

function updateChatPreviewVisibility(show) {
  // 移动端对话不启用预览面板
  if (isMobileChatLayout()) show = false;
  const split = document.getElementById('chatSplitBody');
  const dock = document.getElementById('inputDock');
  split?.classList.toggle('preview-hidden', !show);
  dock?.classList.toggle('with-preview', !!show);
}

function renderChatPreviewEmpty() {
  const frame = document.getElementById('chatPreviewFrame');
  if (!frame) return;
  currentChatHtml = '';
  chatPreviewHistory = [];
  chatPreviewIndex = -1;
  updateChatPreviewVisibility(false);
  frame.innerHTML = `
    <div class="wb-empty" style="width:100%;">
      <div class="big-icon"><svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg></div>
      <div>预览窗口</div>
      <div style="font-size:12px;margin-top:4px;">HTML 页面、图片或回复内容将在这里展示</div>
    </div>
  `;
  const urlEl = document.getElementById('chatPreviewUrl');
  if (urlEl) urlEl.textContent = 'preview://tangprop/chat';
}

function renderChatPreview(html, quiet) {
  const frame = document.getElementById('chatPreviewFrame');
  if (!frame || !html) { renderChatPreviewEmpty(); return; }
  currentChatHtml = html;
  updateChatPreviewVisibility(true);
  frame.innerHTML = '<iframe id="chatPreviewIframe" sandbox="allow-scripts allow-same-origin"></iframe>';
  const iframe = document.getElementById('chatPreviewIframe');
  if (!iframe) return;
  iframe.contentDocument.open();
  iframe.contentDocument.write(html);
  iframe.contentDocument.close();
  const urlEl = document.getElementById('chatPreviewUrl');
  if (urlEl) urlEl.textContent = 'preview://tangprop/chat#' + (chatPreviewIndex + 1);
  if (!quiet) showToast('预览已更新');
}

function renderChatMarkdownPreview(text) {
  if (!text || !text.trim()) return false;
  const body = formatContent(text);
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:28px 32px;line-height:1.65;color:#1d1d1f;background:#fff;max-width:820px;margin:0 auto}
    h1,h2,h3{margin:1.2em 0 0.5em;font-weight:700} p{margin:0.6em 0} code{background:#f5f5f7;padding:2px 6px;border-radius:4px;font-size:0.92em}
    pre{background:#f5f5f7;padding:14px;border-radius:10px;overflow:auto} ul,ol{padding-left:1.4em}
  </style></head><body>${body}</body></html>`;
  pushChatPreviewHistory(html);
  renderChatPreview(html, true);
  return true;
}

function imageDisplayUrl(url) {
  if (!url) return '';
  if (url.startsWith('data:') || url.startsWith('blob:')) return url;
  try {
    const host = new URL(url).hostname;
    // legacy 域名浏览器可直接加载，绕开后端代理（本地 HTTP 代理常对 Pollinations 403）
    if (host === 'image.pollinations.ai' || host === 'gen.pollinations.ai') return url;
    if (host.endsWith('.volces.com')) return url;
  } catch (_) { /* ignore */ }
  if (url.includes('/image/proxy?')) return url.startsWith('http') ? url : `${API}${url}`;
  return `${API}/image/proxy?url=${encodeURIComponent(url)}`;
}

function renderChatPreviewImage(url) {
  if (!url) return;
  const src = imageDisplayUrl(url);
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f5f5f7}img{max-width:100%;max-height:96vh;object-fit:contain;border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,0.08)}</style></head><body><img src="${src.replace(/"/g, '&quot;')}" alt="preview"></body></html>`;
  pushChatPreviewHistory(html);
  renderChatPreview(html, true);
  const urlEl = document.getElementById('chatPreviewUrl');
  if (urlEl) urlEl.textContent = 'preview://tangprop/image';
}

function tryUpdateChatPreviewFromText(text, quiet) {
  const html = extractHtmlFromMarkdown(text);
  if (html) {
    pushChatPreviewHistory(html);
    renderChatPreview(html, quiet);
    return true;
  }
  return false;
}

function syncChatPreviewFromConv(conv) {
  if (!conv || !conv.messages || !conv.messages.length) {
    renderChatPreviewEmpty();
    return;
  }
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const m = conv.messages[i];
    if (m.role === 'assistant' && m.image_url) {
      renderChatPreviewImage(m.image_url);
      return;
    }
    if (m.role === 'assistant' && m.content && !m.pending) {
      if (tryUpdateChatPreviewFromText(m.content, true)) return;
      if (renderChatMarkdownPreview(m.content)) return;
    }
  }
  renderChatPreviewEmpty();
}

function chatPreviewBack() {
  if (chatPreviewIndex > 0) {
    chatPreviewIndex--;
    renderChatPreview(chatPreviewHistory[chatPreviewIndex], true);
  } else showToast('没有更早的预览');
}

function chatPreviewForward() {
  if (chatPreviewIndex < chatPreviewHistory.length - 1) {
    chatPreviewIndex++;
    renderChatPreview(chatPreviewHistory[chatPreviewIndex], true);
  } else showToast('没有更新的预览');
}

function reloadChatPreview() {
  if (currentChatHtml) {
    renderChatPreview(currentChatHtml);
    showToast('已刷新');
  } else {
    syncChatPreviewFromConv(getActiveConv());
  }
}

function setChatPreviewSize(btn, width) {
  document.querySelectorAll('#chatPreviewPanel .wb-browser-actions .wb-nav-btn').forEach(b => {
    if (['桌面', '平板', '手机'].includes(b.title)) b.classList.remove('active');
  });
  if (btn) btn.classList.add('active');
  const iframe = document.getElementById('chatPreviewIframe');
  if (iframe) iframe.style.width = width;
}

function openChatPreviewNewTab() {
  if (!currentChatHtml) { showToast('暂无可预览内容'); return; }
  const blob = new Blob([currentChatHtml], { type: 'text/html' });
  window.open(URL.createObjectURL(blob), '_blank');
}

function initChatResizer() {
  const resizer = document.getElementById('chatResizer');
  const chatPanel = document.getElementById('chatMessagesPanel');
  const body = document.getElementById('chatSplitBody');
  if (!resizer || !chatPanel || !body) return;

  let dragging = false;
  resizer.addEventListener('mousedown', (e) => {
    dragging = true;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = body.getBoundingClientRect();
    const w = e.clientX - rect.left;
    const minW = 280;
    const maxW = rect.width - 300;
    chatPanel.style.flex = 'none';
    chatPanel.style.width = Math.min(Math.max(w, minW), maxW) + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

/* ---- Resizer (flex-based, drag to adjust width) ---- */
function initWorkbenchResizer() {
  const resizer = document.getElementById('wbResizer');
  const chatPanel = document.getElementById('wbChatPanel');
  const body = document.getElementById('workbenchBody');
  if (!resizer || !chatPanel || !body) return;

  let dragging = false;

  resizer.addEventListener('mousedown', (e) => {
    dragging = true;
    wbResizerActive = true;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const bodyRect = body.getBoundingClientRect();
    const newWidth = e.clientX - bodyRect.left;
    const bodyWidth = bodyRect.width;
    const minWidth = 280;
    const maxWidth = bodyWidth - 320; // leave at least 320px for preview
    if (newWidth >= minWidth && newWidth <= maxWidth) {
      chatPanel.style.flex = '0 0 ' + newWidth + 'px';
    }
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    wbResizerActive = false;
    resizer.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function loadWbFromConv(conv) {
  const thread = document.getElementById('wbChatThread');
  if (!thread) return;
  thread.innerHTML = '';
  thread.dataset.seeded = 'true';
  thread.dataset.demoRan = '';
  if (!conv.messages.length) {
    addWbThreadMsg({
      role: 'agent',
      text: '你好！告诉我你想做什么 —— 例如「做一个苹果风格的首页」「给我画一个登录卡片」「设计一个数据看板」。'
    });
    renderWbEmpty();
    return;
  }
  conv.messages.forEach(m => {
    addWbThreadMsg({
      role: m.role === 'user' ? 'user' : 'agent',
      text: m.content || '',
    });
  });
  renderWbEmpty();
}

function switchConv(id) {
  state.draftAgent = false;
  state.activeConv = id;
  const conv = getActiveConv();
  if (conv.isAgent) {
    closeExpertCenter();
    closeInspirationLibrary();
    state.inChat = false;
    state.activeScene = null;
    renderTasks();
    updateInputMode();
    loadWbFromConv(conv);
    const titleEl = document.getElementById('wbTaskTitle');
    if (titleEl) titleEl.textContent = conv.title || '新任务';
    openWorkbench();
    return;
  }
  state.inChat = conv.messages.length > 0;
  state.activeScene = null;
  closeWorkbench();
  if (conv.expertId) {
    const expert = EXPERTS_DATA.find(e => e.id === conv.expertId);
    renderExpertTags(expert || null);
  } else {
    renderExpertTags(null);
  }
  renderTasks();
  updateInputMode();

  const msgsEl = document.getElementById('messages');
  if (state.inChat) {
    msgsEl.innerHTML = conv.messages.map(m => renderMsg(m)).join('');
    msgsEl.scrollTop = msgsEl.scrollHeight;
    syncChatPreviewFromConv(conv);
  } else {
    msgsEl.innerHTML = '';
    renderChatPreviewEmpty();
  }
}

// ── Scenes ──
function selectScene(el) {
  const scene = el.dataset.scene;
  const icon = el.dataset.icon;
  if (scene === '更多') {
    state.activeScene = null;
    renderSceneChips();
    openExpertCenter();
    return;
  }
  if (state.activeScene === scene) {
    state.activeScene = null;
  } else {
    state.activeScene = { name: scene, icon };
  }
  renderSceneChips();
  renderInputTags();
  document.getElementById('userInput').focus();
}

function renderSceneChips() {
  document.querySelectorAll('.scene-chip').forEach(chip => {
    const active = state.activeScene && state.activeScene.name === chip.dataset.scene;
    chip.classList.toggle('active', active);
  });
}

function renderInputTags() {
  const el = document.getElementById('inputTags');
  if (!state.activeScene) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class="input-tag">
      <span>${state.activeScene.icon} ${state.activeScene.name}</span>
      <span class="remove" onclick="clearScene()">×</span>
    </div>
  `;
}

function clearScene() {
  state.activeScene = null;
  renderSceneChips();
  renderInputTags();
  document.getElementById('userInput').focus();
}

// ── Model Dropdown ──
function flattenModels(filter='') {
  const f = filter.toLowerCase().trim();
  let items = [];
  state.providers.forEach(p => {
    p.models.forEach(m => {
      items.push({ provider: p, model: m });
    });
  });
  items.sort((a, b) => {
    if (a.provider.available !== b.provider.available) return b.provider.available - a.provider.available;
    return 0;
  });
  if (f) {
    items = items.filter(it =>
      (it.model.name || it.model.id).toLowerCase().includes(f) ||
      it.provider.name.toLowerCase().includes(f) ||
      (MODEL_META[it.model.id]?.desc || '').toLowerCase().includes(f)
    );
  }
  return items;
}

function renderModelDropdown(filter='') {
  const el = document.getElementById('modelDropdownList');
  if (!state.providers.length) return;

  const items = flattenModels(filter);
  if (!items.length) {
    el.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-tertiary);font-size:13px;">未找到匹配模型</div>`;
    return;
  }

  el.innerHTML = `
    <div class="model-section-label">选择模式</div>
    <div class="model-item auto-item ${state.autoMode ? 'selected' : ''}" onclick="selectAuto()">
      <div class="model-item-left">
        <div class="model-icon">${autoIcon()}</div>
        <div class="model-info">
          <div class="model-name">Auto ${state.autoPrediction ? `→ ${state.autoPrediction.name || state.autoPrediction.id}` : ''}</div>
        </div>
      </div>
      ${state.autoMode ? '<div class="model-check">✓</div>' : ''}
    </div>
    <div class="model-section-label">自定义模型</div>
    ${items.map(it => {
      const p = it.provider;
      const m = it.model;
      const meta = MODEL_META[m.id] || { new: false, desc: m.name || m.id };
      const selected = !state.autoMode && state.selectedProvider === p.id && state.selectedModel === m.id;
      const tags = [
        meta.tag ? `<span class="model-tag ${meta.tag === '限时免费' ? 'free' : 'discount'}">${meta.tag}</span>` : '',
        meta.new && !meta.tag ? `<span class="model-tag new">NEW</span>` : ''
      ].filter(Boolean).join('');
      const right = selected
        ? '<div class="model-check">✓</div>'
        : (meta.rate != null ? `<div class="model-rate">${Number(meta.rate).toFixed(2)}x</div>` : '');
      return `
        <div class="model-item ${selected ? 'selected' : ''} ${!p.available ? 'disabled' : ''}"
             onclick="${p.available ? `selectModel('${p.id}', '${m.id}')` : ''}">
          <div class="model-item-left">
            <div class="model-icon">${getProviderLogo(p.id, p.available)}</div>
            <div class="model-info">
              <div class="model-name">
                ${m.name || m.id}
                <span class="model-tags">${tags}</span>
              </div>
            </div>
          </div>
          ${right}
        </div>
      `;
    }).join('')}
  `;
}

function filterModels(value) { renderModelDropdown(value); }

function isMobileLayout() {
  return window.matchMedia('(max-width: 768px)').matches;
}

function positionModelDropdown() {
  const dd = document.getElementById('modelDropdown');
  const selector = state.modelDropdownAnchor || document.getElementById('modelSelector');
  if (!dd || !selector) return;

  if (isMobileLayout()) {
    dd.style.top = 'auto';
    dd.style.bottom = '0px';
    dd.style.left = '0px';
    dd.style.right = '0px';
    dd.style.width = '100%';
    dd.style.maxHeight = 'min(72vh, 580px)';
    return;
  }

  const rect = selector.getBoundingClientRect();
  const spaceAbove = Math.max(180, rect.top - 24);
  const ddHeight = Math.min(520, spaceAbove);
  let left = rect.left;
  if (left + 340 > window.innerWidth - 12) {
    left = Math.max(12, window.innerWidth - 340 - 12);
  }
  dd.style.right = 'auto';
  dd.style.width = '';
  dd.style.top = 'auto';
  dd.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
  dd.style.left = left + 'px';
  dd.style.maxHeight = ddHeight + 'px';
}

function toggleModelDropdown(e) {
  if (e && e.stopPropagation) e.stopPropagation();
  state.modelDropdownAnchor = (e && e.currentTarget) || document.getElementById('modelSelector');
  const dd = document.getElementById('modelDropdown');
  const bd = document.getElementById('dropdownBackdrop');
  if (!dd || !bd) return;
  const isOpen = dd.classList.contains('open');
  if (isOpen) closeModelDropdown();
  else {
    closeUserMenu();
    closeImageModelDropdown();
    const search = document.getElementById('modelSearch');
    if (search) search.value = '';
    if (!state.providers || !state.providers.length) loadModels();
    renderModelDropdown();
    positionModelDropdown();
    dd.classList.add('open');
    bd.classList.add('open');
  }
}

function closeModelDropdown() {
  document.getElementById('modelDropdown').classList.remove('open');
  document.getElementById('dropdownBackdrop').classList.remove('open');
}

function closeAllDropdowns() { closeModelDropdown(); closeImageModelDropdown(); closeUserMenu(); }

function selectModel(providerId, modelId) {
  state.selectedProvider = providerId;
  state.selectedModel = modelId;
  state.autoMode = false;
  const provider = state.providers.find(p => p.id === providerId);
  const model = provider?.models.find(m => m.id === modelId);

  updateModelDisplay();
  renderModelDropdown();
  closeModelDropdown();
}

function selectAuto() {
  state.autoMode = true;
  state.selectedProvider = null;
  state.selectedModel = null;
  state.autoPrediction = null;
  updateModelDisplay();
  autoDetectModel();
  renderModelDropdown();
  closeModelDropdown();
}

function updateModelDisplay() {
  const dot = document.getElementById('modelDot');
  const name = document.getElementById('modelName');
  const wbInline = document.getElementById('wbModelNameInline');
  const wbDot = document.getElementById('wbModelDotInline');
  const wbBadge = document.getElementById('wbModelName');
  let label = 'Auto';
  let title = '输入问题后自动匹配模型';
  let dotClass = 'dot auto';

  if (state.autoMode) {
    if (state.autoPrediction) {
      label = state.autoPrediction.reason
        ? 'Auto · ' + state.autoPrediction.reason
        : (state.autoPrediction.name || state.autoPrediction.id);
      title = (state.autoPrediction.provider || '') + '/' + (state.autoPrediction.model || state.autoPrediction.id || '');
    }
  } else {
    const provider = state.providers.find(p => p.id === state.selectedProvider);
    const model = provider?.models.find(m => m.id === state.selectedModel);
    label = model?.name || state.selectedModel || 'Auto';
    dotClass = 'dot ' + (provider?.available ? '' : 'offline').trim();
    title = (provider?.name || '') + '/' + (model?.id || '');
  }

  if (name) { name.textContent = label; name.title = title; }
  if (dot) dot.className = dotClass || 'dot auto';
  if (wbInline) { wbInline.textContent = label; wbInline.title = title; }
  if (wbDot) wbDot.className = dotClass || 'dot auto';
  if (wbBadge) {
    wbBadge.textContent = label;
    const host = wbBadge.closest('.wb-model-badge');
    if (host) host.title = title;
  }
}

// ── Auto model matching（按提问内容自动选最适配的免费模型）──
const FREE_PROVIDERS = ['volcengine', 'zhipu', 'siliconflow'];

const EXPERT_AUTO_MODEL = {
  'finance-investment-expert': { provider: 'zhipu', model: 'glm-5.2', reason: '金融专家' },
  'legal-compliance-expert': { provider: 'zhipu', model: 'glm-5.2', reason: '法律专家' },
  'code-tech-expert': { provider: 'zhipu', model: 'glm-5.2', reason: '代码专家' },
  'marketing-expert': { provider: 'volcengine', model: 'doubao-seed-2-1-turbo-260628', reason: '营销专家' },
  'ui-design-expert': { provider: 'zhipu', model: 'glm-4-flash', reason: '设计专家' },
  'ai-prompt-expert': { provider: 'zhipu', model: 'glm-5.2', reason: 'Prompt专家' },
};

const SCENE_AUTO_MODEL = {
  '代码开发': { provider: 'volcengine', model: 'doubao-seed-2-1-pro-260628', reason: '代码开发' },
  '文档处理': { provider: 'volcengine', model: 'doubao-seed-2-1-turbo-260628', reason: '文档处理' },
  '设计创意': { provider: 'zhipu', model: 'glm-4-flash', reason: '设计创意' },
  '金融服务': { provider: 'zhipu', model: 'glm-4-flash', reason: '金融服务' },
  '数据分析': { provider: 'volcengine', model: 'doubao-seed-2-1-pro-260628', reason: '数据分析' },
  '日常办公': { provider: 'zhipu', model: 'glm-4-flash', reason: '日常办公' },
  '日常聊天': { provider: 'volcengine', model: 'doubao-seed-2-1-turbo-260628', reason: '日常聊天' },
  '闲聊': { provider: 'volcengine', model: 'doubao-seed-2-1-turbo-260628', reason: '闲聊' },
};

// 每条规则按优先级列出候选模型（仅免费 provider）
const AUTO_RULES = [
  { pattern: /代码|编程|写一个|实现|bug|debug|函数|API|组件|HTML|CSS|react|vue|node\.js|typescrip|python|java\b|golang|rust\b|写段|重构|优化(代码|性能)|编译|部署|单元测试|集成测试/i,
    candidates: [
      { provider: 'zhipu', model: 'glm-5.2', reason: '代码/编程' },
      { provider: 'volcengine', model: 'doubao-seed-2-1-pro-260628', reason: '代码/编程' },
      { provider: 'zhipu', model: 'glm-4-flash', reason: '代码/编程' },
    ] },
  { pattern: /推理|证明|数学|逻辑|算法|复杂度|为什么|解释.*原理|分析.*原因/i,
    candidates: [
      { provider: 'zhipu', model: 'glm-5.2', reason: '深度推理' },
      { provider: 'volcengine', model: 'doubao-seed-2-1-pro-260628', reason: '深度推理' },
      { provider: 'zhipu', model: 'glm-4-flash', reason: '深度推理' },
    ] },
  { pattern: /翻译|translat|english|英文译|中文译|你会翻译/i,
    candidates: [
      { provider: 'zhipu', model: 'glm-4-flash', reason: '翻译' },
      { provider: 'volcengine', model: 'doubao-seed-2-1-turbo-260628', reason: '翻译' },
    ] },
  { pattern: /设计|创意|头脑风暴|配色|风格|灵感|UI|UX|视觉|海报|banner|logo|动效|界面/i,
    candidates: [
      { provider: 'zhipu', model: 'glm-4-flash', reason: '创意设计' },
      { provider: 'siliconflow', model: 'THUDM/glm-4-9b-chat', reason: '创意设计' },
    ] },
  { pattern: /股票|基金|投资|财报|金融|交易|量化|K线|行情|涨跌|选股|值不值得买|持仓/i,
    candidates: [
      { provider: 'zhipu', model: 'glm-5.2', reason: '金融分析' },
      { provider: 'zhipu', model: 'glm-4-flash', reason: '金融分析' },
      { provider: 'volcengine', model: 'doubao-seed-2-1-pro-260628', reason: '金融分析' },
    ] },
  { pattern: /总结|摘要|归纳|汇总|简报|会议|纪要|报告|写文章|起草|撰写|写一份|研报|论文|写作文|写邮件|写公文/i,
    candidates: [
      { provider: 'zhipu', model: 'glm-5.2', reason: '文档撰写' },
      { provider: 'volcengine', model: 'doubao-seed-2-1-turbo-260628', reason: '文档撰写' },
      { provider: 'zhipu', model: 'glm-4-flash', reason: '文档撰写' },
    ] },
  { pattern: /数据分析|数据清洗|爬虫|抓取|统计|图表|可视化|excel|csv|json.*分析|sql|查询|数据库/i,
    candidates: [
      { provider: 'zhipu', model: 'glm-5.2', reason: '数据处理' },
      { provider: 'volcengine', model: 'doubao-seed-2-1-pro-260628', reason: '数据处理' },
      { provider: 'zhipu', model: 'glm-4-flash', reason: '数据处理' },
    ] },
  { pattern: /prompt|提示词|agent|工作流|结构化输出|json.*输出/i,
    candidates: [
      { provider: 'zhipu', model: 'glm-5.2', reason: 'Prompt工程' },
      { provider: 'volcengine', model: 'doubao-seed-2-1-pro-260628', reason: 'Prompt工程' },
      { provider: 'zhipu', model: 'glm-4-flash', reason: 'Prompt工程' },
    ] },
  { pattern: /法律|法规|合同|诉讼|权益|合规|侵权|审查/i,
    candidates: [
      { provider: 'zhipu', model: 'glm-5.2', reason: '法律合规' },
      { provider: 'zhipu', model: 'glm-4-flash', reason: '法律合规' },
      { provider: 'volcengine', model: 'doubao-seed-2-1-turbo-260628', reason: '法律合规' },
    ] },
  { pattern: /营销|推广|转化|流量|小红书|抖音|投放|品牌|文案/i,
    candidates: [
      { provider: 'volcengine', model: 'doubao-seed-2-1-turbo-260628', reason: '市场营销' },
      { provider: 'zhipu', model: 'glm-4-flash', reason: '市场营销' },
    ] },
  { pattern: /价格|多少钱|费用|报价|最新|今天|最近|新闻|时事|热点/i,
    candidates: [
      { provider: 'zhipu', model: 'glm-4-flash', reason: '时效问答' },
      { provider: 'volcengine', model: 'doubao-seed-2-1-turbo-260628', reason: '时效问答' },
    ] },
  { pattern: /客服|问答|帮助|怎么(做|弄|办|用)|如何|教程|步骤|指南|操作流程|使用方法|安装|配置|设置/i,
    candidates: [
      { provider: 'zhipu', model: 'glm-4-flash', reason: '教程指导' },
      { provider: 'volcengine', model: 'doubao-seed-2-1-turbo-260628', reason: '教程指导' },
    ] },
  { pattern: /日常|聊天|开玩笑|笑话|梗|好玩|有趣|推荐|美食|旅游|电影|游戏|音乐/i,
    candidates: [
      { provider: 'volcengine', model: 'doubao-seed-2-1-turbo-260628', reason: '闲聊' },
      { provider: 'zhipu', model: 'glm-4-flash', reason: '闲聊' },
    ] },
  { pattern: /你(是|能|会|知道|有没有|有什么)|介绍.*自己|什么是|是什么|解释|概念|定义/i,
    candidates: [
      { provider: 'zhipu', model: 'glm-4-flash', reason: '知识问答' },
      { provider: 'volcengine', model: 'doubao-seed-2-1-turbo-260628', reason: '知识问答' },
    ] },
];

const COMPLEXITY_DEFAULTS = {
  high: [
    { provider: 'zhipu', model: 'glm-5.2', reason: '复杂任务' },
    { provider: 'volcengine', model: 'doubao-seed-2-1-pro-260628', reason: '复杂任务' },
    { provider: 'zhipu', model: 'glm-4-flash', reason: '复杂任务' },
  ],
  medium: [
    { provider: 'volcengine', model: 'doubao-seed-2-1-turbo-260628', reason: '通用对话' },
    { provider: 'zhipu', model: 'glm-4-flash', reason: '通用对话' },
  ],
  low: [
    { provider: 'volcengine', model: 'doubao-seed-2-1-turbo-260628', reason: '轻量快速' },
    { provider: 'zhipu', model: 'glm-4-flash', reason: '轻量快速' },
    { provider: 'siliconflow', model: 'Qwen/Qwen2.5-7B-Instruct', reason: '轻量快速' },
  ],
};

function estimateComplexity(text) {
  const chars = text.length;
  if (chars > 2000) return 'high';
  if (chars > 500) return 'medium';
  return 'low';
}

function getMatchContext(convOrHint) {
  if (!convOrHint) return {};
  if (convOrHint.expertId) return { expertId: convOrHint.expertId };
  if (state.pendingExpert) return { expertId: state.pendingExpert.expertId };
  return {};
}

function pickFromCandidates(candidates) {
  for (const c of candidates) {
    const found = findModel(c.model, c.provider);
    if (found) return { ...found, reason: c.reason };
  }
  return null;
}

const VISION_AUTO_CANDIDATES = [
  { provider: 'volcengine', model: 'doubao-seed-2-1-turbo-260628', reason: '看图理解' },
  { provider: 'volcengine', model: 'doubao-seed-2-1-pro-260628', reason: '看图理解' },
  { provider: 'zhipu', model: 'glm-4v-flash', reason: '看图理解' },
  { provider: 'zhipu', model: 'glm-4-flash', reason: '看图理解' },
];

function matchModel(text, complexity, convOrHint, hasImages) {
  const ctx = getMatchContext(convOrHint);

  // 0) 有上传图片：优先走支持视觉的模型
  if (hasImages) {
    const visionPick = pickFromCandidates(VISION_AUTO_CANDIDATES);
    if (visionPick) return visionPick;
  }

  // 1) 专家会话：优先按本条提问内容匹配；无明确关键词时用专家默认模型
  if (ctx.expertId && EXPERT_AUTO_MODEL[ctx.expertId]) {
    for (const rule of AUTO_RULES) {
      if (rule.pattern.test(text)) {
        const contentMatch = pickFromCandidates(rule.candidates);
        if (contentMatch) return contentMatch;
      }
    }
    const expertPick = pickFromCandidates([EXPERT_AUTO_MODEL[ctx.expertId]]);
    if (expertPick) return expertPick;
  }

  // 2) 场景标签
  if (state.activeScene && SCENE_AUTO_MODEL[state.activeScene.name]) {
    const picked = pickFromCandidates([SCENE_AUTO_MODEL[state.activeScene.name]]);
    if (picked) return picked;
  }

  // 3) 关键词规则
  for (const rule of AUTO_RULES) {
    if (rule.pattern.test(text)) {
      const picked = pickFromCandidates(rule.candidates);
      if (picked) return picked;
    }
  }

  // 4) 按长度复杂度默认
  return pickFromCandidates(COMPLEXITY_DEFAULTS[complexity] || COMPLEXITY_DEFAULTS.low);
}

function findModel(modelId, providerId) {
  let provider = state.providers.find(p => p.id === providerId && p.available && FREE_PROVIDERS.includes(p.id));
  if (provider) {
    const model = provider.models.find(m => m.id === modelId);
    if (model) return { provider: providerId, model: modelId, name: model.name || modelId };
  }
  for (const p of state.providers) {
    if (!p.available || !FREE_PROVIDERS.includes(p.id)) continue;
    const m = p.models.find(m => m.id === modelId);
    if (m) return { provider: p.id, model: m.id, name: m.name || m.id };
  }
  const fallback = state.providers.find(p => p.available && FREE_PROVIDERS.includes(p.id));
  if (fallback) {
    const m = fallback.models[0];
    return { provider: fallback.id, model: m.id, name: m.name || m.id };
  }
  return null;
}

function resolveAutoSelection() {
  if (!state.autoMode || !state.autoPrediction) return null;
  const pred = state.autoPrediction;
  const provider = state.providers.find(p => p.id === pred.provider && p.available && FREE_PROVIDERS.includes(p.id));
  if (!provider) {
    const fb = state.providers.find(p => p.available && FREE_PROVIDERS.includes(p.id));
    if (!fb) return null;
    return { provider: fb.id, model: fb.default_model || fb.models[0]?.id, reason: pred.reason };
  }
  const model = provider.models.find(m => m.id === pred.model);
  if (model) return { provider: pred.provider, model: pred.model, reason: pred.reason };
  return { provider: provider.id, model: provider.default_model || provider.models[0]?.id, reason: pred.reason };
}

/** 发送前：根据本条消息内容解析模型（Auto 模式） */
function resolveModelForMessage(text, convOrHint, hasImages) {
  const complexity = estimateComplexity(text);
  const prediction = matchModel(text, complexity, convOrHint, !!hasImages);
  state.autoPrediction = prediction;
  state._lastAutoText = text;
  updateModelDisplay();
  return resolveAutoSelection();
}

function autoDetectModel() {
  if (!state.autoMode || !state.providers.length) return;
  const input = document.getElementById('userInput');
  const text = input ? input.value.trim() : '';
  if (!text) { state.autoPrediction = null; updateModelDisplay(); return; }
  const conv = state.pendingExpert
    ? { expertId: state.pendingExpert.expertId }
    : getActiveConv();
  resolveModelForMessage(text, conv);
}

function toggleMaxModeFromDropdown() {
  state.maxMode = !state.maxMode;
  document.getElementById('maxModeToggle').classList.toggle('active', state.maxMode);
  showToast(state.maxMode ? 'Max 模式已开启' : 'Max 模式已关闭');
}

// ── Input Mode (home center vs chat bottom) ──
function updateInputMode() {
  const dock = document.getElementById('inputDock');
  const homeView = document.getElementById('homeView');
  const chatView = document.getElementById('chatView');
  const headerTitle = document.getElementById('headerTitle');
  const homeBottomBar = document.getElementById('homeBottomBar');
  const chatBottomHint = document.getElementById('chatBottomHint');
  const thinkingHint = document.getElementById('thinkingHint');
  const sendBtn = document.getElementById('sendBtn');

  if (state.inChat) {
    // 输入框挂到 chat-view 底部，避免移动端预览面板把输入框顶到屏幕中间
    if (chatView && dock && dock.parentElement !== chatView) chatView.appendChild(dock);
    if (chatView && chatBottomHint && chatBottomHint.parentElement !== chatView) {
      chatView.appendChild(chatBottomHint);
    }
    if (chatView && dock) chatView.appendChild(dock);
    if (chatView && chatBottomHint) chatView.appendChild(chatBottomHint);

    dock?.classList.remove('home-mode');
    dock?.classList.add('chat-mode');
    homeView?.classList.add('hidden');
    chatView?.classList.add('active');
    headerTitle?.classList.add('visible');
    if (homeBottomBar) homeBottomBar.style.display = 'none';
    if (chatBottomHint) chatBottomHint.style.opacity = '1';
    if (thinkingHint) thinkingHint.style.opacity = '1';
    if (sendBtn) sendBtn.className = 'send-btn';
    if (headerTitle) headerTitle.textContent = getActiveConv().title || 'TangProp';
    const conv = getActiveConv();
    const hasPreview = !!(conv.messages && conv.messages.some(m =>
      m.role === 'assistant' && (m.image_url || extractHtmlFromMarkdown(m.content || ''))
    ));
    updateChatPreviewVisibility(hasPreview);
  } else {
    if (homeView && dock && dock.parentElement !== homeView) homeView.appendChild(dock);
    if (chatHintDefaultParent && chatBottomHint && chatBottomHint.parentElement !== chatHintDefaultParent) {
      chatHintDefaultParent.appendChild(chatBottomHint);
    }
    updateChatPreviewVisibility(false);
    dock?.classList.remove('chat-mode');
    dock?.classList.add('home-mode');
    if (dock && homeView && dock.parentElement !== homeView) homeView.appendChild(dock);
    homeView?.classList.remove('hidden');
    chatView?.classList.remove('active');
    headerTitle?.classList.remove('visible');
    if (homeBottomBar) homeBottomBar.style.display = 'flex';
    if (chatBottomHint) chatBottomHint.style.opacity = '0';
    if (thinkingHint) thinkingHint.style.opacity = '0';
    if (sendBtn) sendBtn.className = 'send-btn';
  }
}

// ── Prompt shortcuts ──
function usePrompt(text) {
  const input = document.getElementById('userInput');
  input.value = text;
  autoResize(input);
  input.focus();
}

// ── Chat ──
function ensureChatTask(firstText) {
  if (state.pendingExpert) {
    const pe = state.pendingExpert;
    const id = 'conv_' + Date.now();
    const title = pe.title || '专家咨询';
    const conv = { id, title, messages: [], time: '刚刚', expertContext: pe.expertContext, expertId: pe.expertId };
    state.conversations.unshift(conv);
    state.activeConv = id;
    state.pendingExpert = null;
    document.getElementById('messages').innerHTML = '';
    renderChatPreviewEmpty();
    renderTasks();
    saveConversations();
    return conv;
  }

  const active = getActiveConv();
  // 已在对话中，或当前任务就是空的 — 继续用当前任务
  if (state.inChat || !(active.messages && active.messages.length)) {
    return active;
  }

  // 从首页发起且当前任务已有内容 — 新建任务（生图 / 聊天均适用）
  const id = 'conv_' + Date.now();
  const title = (firstText || '新任务').slice(0, 24) + ((firstText || '').length > 24 ? '...' : '');
  const conv = { id, title, messages: [], time: '刚刚' };
  state.conversations.unshift(conv);
  state.activeConv = id;
  document.getElementById('messages').innerHTML = '';
  renderChatPreviewEmpty();
  renderTasks();
  saveConversations();
  return conv;
}

function getExpertContext(conv) {
  if (!conv.expertId) return conv.expertContext || null;
  var expert = EXPERTS_DATA.find(function(e) { return e.id === conv.expertId; });
  if (expert) return buildExpertSystemContext(expert);
  return conv.expertContext || null;
}

function getExpertPrefill(conv) {
  if (!conv.expertId) return null;
  var expert = EXPERTS_DATA.find(function(e) { return e.id === conv.expertId; });
  return expert && expert.assistantPrefill ? expert.assistantPrefill : null;
}

/** 是否仍用专家模式：追问/吐槽/指代图片时改走普通对话 */
function shouldUseExpertMode(conv, text) {
  if (!conv.expertId && !conv.expertContext) return false;
  const t = (text || '').trim();
  if (!t) return false;
  // 短句追问、指代「这图/刚才」— 需要正常沟通，不要套专家模板
  if (/^(这|那|刚|上)(张|幅|个)?(图|图片|玩意儿|东西|回复)?/.test(t)) return false;
  if (/^(这是|这是啥|这是什么|啥玩意儿|什么玩意儿|怎么回事|看不懂|不对|错了)/.test(t)) return false;
  if (/^(怎么|为什么|为何).{0,20}[？?]?$/.test(t) && t.length <= 24) return false;
  if (/^(重新|再来|换一个|不对啊)/.test(t)) return false;
  // 上一条助手消息是图片，用户在追问图 — 普通对话
  const msgs = conv.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant') {
      if (msgs[i].image_url && t.length <= 48) return false;
      break;
    }
  }
  return true;
}

function buildConversationHistory(conv) {
  const msgs = (conv && conv.messages) || [];
  // 当前轮：最后一条非 pending 的 user 会作为 payload.message，不放进 history
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i] && msgs[i].role === 'user' && !msgs[i].pending) {
      lastUserIdx = i;
      break;
    }
  }
  const hist = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m || i === lastUserIdx || m.pending) continue;
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    let content = String(m.content || '').trim();
    if (!content) continue;
    // 跳过纯 UI / HTML 占位
    if (m.raw && content.indexOf('<div') === 0) continue;
    if (content.length > 6000) content = content.slice(0, 6000);
    hist.push({ role: m.role, content });
  }
  return hist.slice(-16);
}

function buildChatPayload(text, providerId, modelId, images, conv) {
  const useExpert = shouldUseExpertMode(conv, text);
  var expertCtx = useExpert ? getExpertContext(conv) : null;
  var expertPrefill = useExpert ? getExpertPrefill(conv) : null;
  var message = text;
  if (expertCtx) {
    message = text + '\n\n【专家回复要求】继续完成 ## 分析要点 和 ## 建议 两节；给出可执行清单，最后最多追问 1 个问题。';
    if (conv.expertId && conv.expertContext !== expertCtx) {
      conv.expertContext = expertCtx;
    }
  }
  var history = buildConversationHistory(conv);
  var payload = {
    message: message,
    provider: providerId,
    model: modelId,
    ...(images.length ? { images } : {}),
    ...(history.length ? { history } : {}),
    ...(expertCtx ? { system_context: expertCtx } : {}),
    ...(expertPrefill ? { expert_prefill: expertPrefill } : {}),
  };
  if (expertCtx) {
    payload.max_tokens = 8192;
    payload.max_turns = 2;
  } else if (state.maxMode) {
    payload.max_tokens = 32768;
    payload.max_turns = 50;
  } else {
    const thinkingTokens = THINKING_LEVELS.find(t => t.id === state.thinkingLevel)?.tokens;
    if (thinkingTokens) payload.max_tokens = thinkingTokens;
  }
  if (state.agentPermission === 'readonly') {
    payload.system_context = (payload.system_context || '') + '\n【权限】只读模式：不要修改或删除任何文件。';
  } else if (state.agentPermission === 'full') {
    payload.system_context = (payload.system_context || '') + '\n【权限】完全授权：可执行必要的命令与部署操作。';
  }
  return payload;
}

async function regenerateResponse() {
  const conv = getActiveConv();
  if (state.loading || !conv.messages.length) return;
  const lastUserIdx = [...conv.messages].map((m, i) => m.role === 'user' ? i : -1).filter(i => i >= 0).pop();
  if (lastUserIdx === undefined) { showToast('没有可重新生成的消息'); return; }
  const lastUser = conv.messages[lastUserIdx];
  if (conv.messages.length > lastUserIdx + 1 && conv.messages[lastUserIdx + 1].role === 'assistant') {
    conv.messages.splice(lastUserIdx + 1, 1);
  }
  const msgsEl = document.getElementById('messages');
  msgsEl.innerHTML = conv.messages.map(m => renderMsg(m)).join('');
  state.loading = true;
  document.getElementById('sendBtn').disabled = true;
  await resendChatMessage(lastUser.content, lastUser.scene, lastUser.images);
}

function getActiveConv() {
  let conv = state.conversations.find(c => c.id === state.activeConv);
  if (!conv) {
    conv = { id: state.activeConv, title: '新任务', messages: [], time: '刚刚' };
    state.conversations.push(conv);
  }
  return conv;
}

function enterChat() {
  if (state.inChat) return;
  state.inChat = true;
  updateInputMode();
  if (!chatPreviewHistory.length) updateChatPreviewVisibility(false);
}

function renderMsg(m) {
  const role = m.role === 'user' ? 'user' : 'assistant';
  const idAttr = m.id ? ` id="${m.id}"` : '';
  if (role === 'user') {
    const scene = m.scene;
    const imgHtml = (m.images && m.images.length)
      ? `<div class="msg-images">${m.images.map(src => `<img src="${src}" class="msg-user-img" alt="用户上传图片">`).join('')}</div>`
      : '';
    const hasText = m.content && m.content.length > 0;
    const pill = (hasText || scene)
      ? `<div class="msg-pill">
          ${scene ? `<span class="tag">${scene.icon} ${scene.name}</span>` : ''}
          ${hasText ? `<span>${escapeHtml(m.content)}</span>` : ''}
        </div>`
      : '';
    return `
      <div class="msg user"${idAttr}>
        ${imgHtml}
        ${pill}
      </div>`;
  }
  // assistant — 图片消息
  if (m.image_url) {
    const prompt = m.image_prompt || (m.content || '').replace(/^\[图片\]\s*/, '') || '';
    const url = escapeHtml(m.image_url);
    const displayUrl = escapeHtml(imageDisplayUrl(m.image_url));
    const promptEsc = escapeHtml(prompt);
    const imgActions = m.pending ? '' : `
      <div class="msg-actions">
        <button class="msg-action-btn" title="在新窗口打开" onclick="window.open('${url}', '_blank')"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></button>
        <button class="msg-action-btn" title="下载图片" onclick="downloadImage('${url}','tangprop-${Date.now()}.jpg')"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>
        <button class="msg-action-btn" title="复制链接" onclick="copyToClipboard('${url}')"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
        <button class="msg-action-btn" title="重新生成" onclick="regenerateImage('${promptEsc}')"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>
        <span class="msg-meta">${escapeHtml(m.model || '图片生成')}</span>
      </div>`;
    return `
      <div class="msg assistant"${idAttr}>
        <div class="msg-header">
          <div class="msg-avatar"><img src="pupu-avatar.jpg" alt="PUPU"></div>
          <div><div class="msg-author">TangProp</div></div>
        </div>
        <div class="msg-bubble">
          <div class="msg-image">
            <img src="${displayUrl}" alt="${promptEsc}" loading="lazy"
                 onerror="this.onerror=null;this.src='${url}'">
            ${promptEsc ? `<div class="msg-image-caption"><span class="msg-image-prompt">${promptEsc}</span></div>` : ''}
          </div>
        </div>
        ${imgActions}
      </div>`;
  }
  const content = m.raw ? m.content : formatContent(m.content);
  const reasoning = m.reasoning ? `<div class="reasoning-badge"><span class="pulse"></span>深度思考</div>` : '';
  const actions = m.pending ? '' : `
    <div class="msg-actions">
      <button class="msg-action-btn" title="复制" onclick="copyMsg(this)"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
      <button class="msg-action-btn" title="点赞" onclick="rateMsg(this, 1)"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-3 3l-1 5H6a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h10l3-7V9z"/></svg></button>
      <button class="msg-action-btn" title="点踩" onclick="rateMsg(this, -1)"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15v4a3 3 0 0 0 3-3l1-5h4a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H8L5 11v4z" transform="scale(1,-1) translate(0,-20)"/></svg></button>
      <button class="msg-action-btn" title="转发" onclick="forwardMsg(this)"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg></button>
      <button class="msg-action-btn" title="重新生成" onclick="regenerateResponse()"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg></button>
    </div>
  `;
  return `
    <div class="msg assistant"${idAttr}>
      <div class="msg-header">
        <div class="msg-avatar"><img src="pupu-avatar.jpg" alt="PUPU"></div>
        <div>
          <div class="msg-author">TangProp</div>
          ${reasoning}
        </div>
      </div>
      <div class="msg-bubble">${content}</div>
      ${actions}
    </div>`;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Image Upload ──
/** 压缩上传图：限制边长/体积，并避免过小尺寸导致视觉模型拒收 */
function normalizeChatImageDataUrl(dataUrl, maxEdge) {
  maxEdge = maxEdge || 1536;
  return new Promise(function(resolve) {
    if (!dataUrl || typeof dataUrl !== 'string') { resolve(''); return; }
    const img = new Image();
    img.onload = function() {
      try {
        let w = img.naturalWidth || img.width || 0;
        let h = img.naturalHeight || img.height || 0;
        if (!w || !h) { resolve(dataUrl); return; }
        // 豆包视觉最小约 14px，过小则放大
        if (Math.min(w, h) < 32) {
          const scaleUp = 32 / Math.min(w, h);
          w = Math.max(32, Math.round(w * scaleUp));
          h = Math.max(32, Math.round(h * scaleUp));
        }
        const scale = Math.min(1, maxEdge / Math.max(w, h));
        const cw = Math.max(32, Math.round(w * scale));
        const ch = Math.max(32, Math.round(h * scale));
        const canvas = document.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, cw, ch);
        ctx.drawImage(img, 0, 0, cw, ch);
        resolve(canvas.toDataURL('image/jpeg', 0.88));
      } catch (_) {
        resolve(dataUrl);
      }
    };
    img.onerror = function() { resolve(dataUrl); };
    img.src = dataUrl;
  });
}

function handleImageSelect(input) {
  const files = input.files;
  if (!files || files.length === 0) return;
  for (const file of files) {
    if (!file.type.startsWith('image/')) {
      showToast('请选择图片文件');
      continue;
    }
    if (file.size > 5 * 1024 * 1024) {
      showToast('图片不能超过 5MB');
      continue;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      normalizeChatImageDataUrl(e.target.result, 1536).then(function(url) {
        if (!url) return;
        state.pendingImages.push(url);
        renderImagePreview();
      });
    };
    reader.readAsDataURL(file);
  }
  input.value = '';
}

function renderImagePreview() {
  const bar = document.getElementById('imagePreviewBar');
  if (!bar) return;
  if (state.pendingImages.length === 0) {
    bar.style.display = 'none';
    bar.innerHTML = '';
    return;
  }
  bar.style.display = 'flex';
  bar.innerHTML = state.pendingImages.map((src, i) => `
    <div class="img-thumb">
      <img src="${src}" alt="预览">
      <button class="remove-btn" onclick="removePendingImage(${i})">✕</button>
    </div>
  `).join('');
}

function removePendingImage(index) {
  state.pendingImages.splice(index, 1);
  renderImagePreview();
}

function formatContent(text) {
  if (!text) return '';
  let escaped = escapeHtml(text);
  escaped = escaped.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
  escaped = escaped.replace(/`([^`]+)`/g, '<code>$1</code>');
  escaped = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  escaped = escaped.replace(/\n/g, '<br>');
  return escaped;
}

function copyMsg(btn) {
  const bubble = btn.closest('.msg').querySelector('.msg-bubble');
  const text = bubble.innerText;
  navigator.clipboard.writeText(text).then(() => showToast('已复制'));
}

function addMsg(role, content, extra={}) {
  const conv = getActiveConv();
  conv.messages.push({ role, content, ...extra });
  if (conv.messages.length === 1 && role === 'user') {
    conv.title = content.slice(0, 24) + (content.length > 24 ? '...' : '');
  }
  conv.time = '刚刚';
  const msgsEl = document.getElementById('messages');
  msgsEl.insertAdjacentHTML('beforeend', renderMsg({ role, content, ...extra }));
  msgsEl.scrollTop = msgsEl.scrollHeight;
  renderTasks();
  if (state.inChat) document.getElementById('headerTitle').textContent = conv.title || 'TangProp';
  saveConversations();
}

// ── Send ──
let chatAbortController = null;

function stopChatStream() {
  if (chatAbortController) {
    try { chatAbortController.abort(); } catch (_) {}
    chatAbortController = null;
  }
  state.loading = false;
  const sendBtn = document.getElementById('sendBtn');
  if (sendBtn) {
    sendBtn.disabled = false;
    sendBtn.title = '发送';
    sendBtn.classList.remove('stopping');
  }
}

function setSendButtonMode(mode) {
  const sendBtn = document.getElementById('sendBtn');
  if (!sendBtn) return;
  if (mode === 'stop') {
    sendBtn.disabled = false;
    sendBtn.title = '停止生成';
    sendBtn.classList.add('stopping');
    sendBtn.setAttribute('data-mode', 'stop');
  } else {
    sendBtn.disabled = false;
    sendBtn.title = '发送';
    sendBtn.classList.remove('stopping');
    sendBtn.removeAttribute('data-mode');
  }
}

async function sendMessage() {
  const input = document.getElementById('userInput');
  let text = input.value.trim();
  const images = [...state.pendingImages];
  // 生成中再点发送：停止当前回复，而不是静默吞掉追问
  if (state.loading) {
    const sendBtn = document.getElementById('sendBtn');
    if (sendBtn && sendBtn.getAttribute('data-mode') === 'stop') {
      stopChatStream();
      showToast('已停止生成，可以继续追问');
      return;
    }
    showToast('上一条还在回复中，请稍候，或再点一次停止');
    setSendButtonMode('stop');
    return;
  }
  if (!text && images.length === 0) return;
  // 只传图时补一句默认问题，避免模型收到空文本
  if (!text && images.length) {
    text = '请仔细查看这张图片，描述你看到的内容，并给出关键信息。';
  }
  const scene = state.activeScene;

  // ── 按本条提问内容自动匹配模型（Auto 模式）
  let providerId, modelId, modelDisplayName, matchReason;
  const convHint = state.pendingExpert
    ? { expertId: state.pendingExpert.expertId }
    : getActiveConv();
  if (state.autoMode) {
    const resolved = resolveModelForMessage(text, convHint, images.length > 0);
    if (!resolved) {
      showToast('暂无可用模型，请先选择模型');
      toggleModelDropdown({ stopPropagation: () => {} });
      return;
    }
    providerId = resolved.provider;
    modelId = resolved.model;
    matchReason = resolved.reason;
    const _p = state.providers.find(p => p.id === providerId);
    const _m = _p?.models.find(m => m.id === modelId);
    modelDisplayName = matchReason
      ? 'Auto · ' + matchReason
      : (_m?.name || modelId);
  } else {
    if (!state.selectedProvider || !state.selectedModel) {
      showToast('请先选择对话模型');
      toggleModelDropdown({ stopPropagation: () => {} });
      return;
    }
    providerId = state.selectedProvider;
    modelId = state.selectedModel;
    modelDisplayName = modelId;
    // 手动选了纯文本模型但带了图：提示并自动切到看图模型
    if (images.length) {
      const vision = pickFromCandidates(VISION_AUTO_CANDIDATES);
      if (vision && !(modelId.includes('vision') || modelId.includes('4v') || modelId.includes('seed'))) {
        providerId = vision.provider;
        modelId = vision.model;
        modelDisplayName = '看图 · ' + (vision.reason || modelId);
        showToast('已自动切换到支持看图的模型');
      }
    }
  }

  // 决定好模型后才清空 input 和图片
  input.value = '';
  autoResize(input);
  state.pendingImages = [];
  renderImagePreview();

  // ── 文生图 / 图生图（转插画）指令检测 ──
  if (images.length > 0 && isImageEditIntent(text)) {
    const prompt = buildImageEditPrompt(text);
    await handleImageRequest(prompt, text, scene, images);
    return;
  }
  if (images.length === 0) {
    const imgMatch = text.match(/^(?:画(?:一张|张|一幅|一个|只|个|幅)?|生成(?:一张|张|幅|个)?图?|画个|画幅|draw\s+(?:a|an)?|generate\s+(?:an?\s+)?image(?:\s+of)?)\s*[:：，,。.、\s]?\s*(.+)$/i);
    if (imgMatch) {
      const prompt = (imgMatch[1] || '').trim();
      if (prompt) {
        await handleImageRequest(prompt, text, scene);
        return;
      }
    }
  }

  state.loading = true;
  setSendButtonMode('stop');

  ensureChatTask(text);
  enterChat();
  addMsg('user', text, { scene, images: images.length ? images : undefined });
  if (!document.getElementById('chatPreviewIframe')) renderChatPreviewEmpty();

  await streamChatResponse(text, images, providerId, modelId, modelDisplayName);
}

async function streamChatResponse(text, images, providerId, modelId, modelDisplayName) {
  const msgsEl = document.getElementById('messages');
  const pendingId = 'pending-' + Date.now();
  msgsEl.insertAdjacentHTML('beforeend', renderMsg({
    role: 'assistant',
    id: pendingId,
    content: '<div class="typing-dots"><span></span><span></span><span></span></div>',
    raw: true,
    reasoning: true,
    pending: true,
  }));
  msgsEl.scrollTop = msgsEl.scrollHeight;

  let fullText = '';
  const conv = getActiveConv();
  const useExpert = shouldUseExpertMode(conv, text);
  const expertPrefill = useExpert ? getExpertPrefill(conv) : null;
  if (expertPrefill) fullText = expertPrefill;
  conv.messages.push({ role: 'assistant', content: '', reasoning: true, pending: true, model: modelDisplayName });

  chatAbortController = new AbortController();
  try {
    const res = await apiFetch(`${API}/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildChatPayload(text, providerId, modelId, images || [], conv)),
      signal: chatAbortController.signal,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(apiErrorDetail(err, `请求失败 (${res.status})`));
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      if (chatAbortController && chatAbortController.signal.aborted) {
        try { await reader.cancel(); } catch (_) {}
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const chunk = JSON.parse(trimmed);
          const pending = document.getElementById(pendingId);
          if (!pending) continue;

          if (chunk.type === 'status') {
            const badge = pending.querySelector('.reasoning-badge');
            if (badge) {
              const note = chunk.note ? ` · ${escapeHtml(chunk.note)}` : '';
              badge.innerHTML = `<span class="pulse"></span>深度思考 · 第 ${chunk.turn || 1} 步${note}`;
            }
          } else if (chunk.type === 'tool_call') {
            const badge = pending.querySelector('.reasoning-badge');
            if (badge) badge.innerHTML = `<span class="pulse"></span>调用工具 · ${escapeHtml(chunk.tool || chunk.name || '')}`;
          } else if (chunk.type === 'text_start') {
            if (!fullText && expertPrefill) fullText = expertPrefill;
            if (!fullText) pending.querySelector('.msg-bubble').innerHTML = '';
            else pending.querySelector('.msg-bubble').innerHTML = formatContent(fullText);
          } else if (chunk.type === 'text_reset') {
            // 清掉「请稍等」等空话，准备接收真正答案
            fullText = expertPrefill || '';
            const bubble = pending.querySelector('.msg-bubble');
            if (bubble) {
              bubble.innerHTML = fullText
                ? formatContent(fullText)
                : '<div class="typing-dots"><span></span><span></span><span></span></div>';
            }
            const badge = pending.querySelector('.reasoning-badge');
            if (badge) badge.innerHTML = `<span class="pulse"></span>正在作答…`;
          } else if (chunk.type === 'text') {
            fullText += chunk.content || chunk.delta || '';
            pending.querySelector('.msg-bubble').innerHTML = formatContent(fullText);
            msgsEl.scrollTop = msgsEl.scrollHeight;
            if (extractHtmlFromMarkdown(fullText)) tryUpdateChatPreviewFromText(fullText, true);
          } else if (chunk.type === 'text_end') {
            // 段落结束 ≠ 整轮结束：工具调用后还会继续输出，这里不要标「已完成」
            const badge = pending.querySelector('.reasoning-badge');
            if (badge) badge.innerHTML = `<span class="pulse"></span>整理回复中…`;
          } else if (chunk.type === 'error') {
            throw new Error(chunk.message || '模型返回错误');
          }
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          throw e;
        }
      }
    }

    const pending = document.getElementById(pendingId);
    if (pending && fullText) {
      const bubble = pending.querySelector('.msg-bubble');
      if (bubble) bubble.innerHTML = formatContent(fullText);
    }
    if (pending) {
      const badge = pending.querySelector('.reasoning-badge');
      if (badge) badge.innerHTML = '<span>✓</span> 已完成';
      pending.querySelector('.msg-bubble').insertAdjacentHTML('afterend', `
        <div class="msg-actions">
          <button class="msg-action-btn" title="复制" onclick="copyMsg(this)"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
          <button class="msg-action-btn" title="点赞" onclick="rateMsg(this, 1)"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-3 3L7 12v8h10l3-6V9z"/><line x1="7" y1="12" x2="7" y2="22"/></svg></button>
          <button class="msg-action-btn" title="点踩" onclick="rateMsg(this, -1)"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15v-4a3 3 0 0 1 3-3l4 3v8H7l-3-6V9z" transform="scale(-1,1) translate(-24,0)"/><line x1="17" y1="12" x2="17" y2="2"/></svg></button>
          <button class="msg-action-btn" title="转发" onclick="forwardMsg(this)"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg></button>
          <button class="msg-action-btn" title="重新生成" onclick="regenerateResponse()"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>
        </div>
      `);
    }

    const lastMsg = conv.messages[conv.messages.length - 1];
    if (lastMsg && lastMsg.role === 'assistant') {
      lastMsg.content = fullText;
      lastMsg.reasoning = false;
      lastMsg.pending = false;
      lastMsg.model = modelDisplayName;
    }
    if (fullText) {
      if (!tryUpdateChatPreviewFromText(fullText, true)) renderChatMarkdownPreview(fullText);
    }
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')));
    const pending = document.getElementById(pendingId);
    const prefillOnly = expertPrefill && (fullText === expertPrefill || !fullText.replace(expertPrefill, '').trim());
    if (pending) {
      const bubble = pending.querySelector('.msg-bubble');
      let fallback;
      if (aborted) {
        fallback = fullText
          ? formatContent(fullText) + `<br><span style="color:var(--text-secondary);font-size:13px;">（已停止生成）</span>`
          : `<span style="color:var(--text-secondary)">已停止生成</span>`;
      } else if (prefillOnly) {
        fallback = `<span style="color:var(--danger)">暂时无法连接模型：${escapeHtml(e.message)}</span><br><span style="color:var(--text-secondary);font-size:13px;margin-top:8px;display:inline-block;">请检查网络或稍后重试。若你在追问上一张图，可直接说「解释这张图」或新建对话。</span>`;
      } else if (fullText) {
        fallback = formatContent(fullText) + `<br><span style="color:var(--danger)">（${escapeHtml(e.message)}）</span>`;
      } else {
        fallback = `<span style="color:var(--danger)">错误: ${escapeHtml(e.message)}</span>`;
      }
      if (bubble) bubble.innerHTML = fallback;
      const badge = pending.querySelector('.reasoning-badge');
      if (badge) badge.innerHTML = aborted ? '<span>✓</span> 已停止' : '';
      if (badge && !aborted) badge.style.display = 'none';
    }
    const lastMsg = conv.messages[conv.messages.length - 1];
    if (lastMsg && lastMsg.role === 'assistant') {
      lastMsg.content = aborted
        ? (fullText || '已停止生成')
        : (prefillOnly ? `暂时无法连接模型：${e.message}` : (fullText || `错误: ${e.message}`));
      lastMsg.reasoning = false;
      lastMsg.pending = false;
      lastMsg.model = modelDisplayName;
    }
  } finally {
    chatAbortController = null;
    state.loading = false;
    setSendButtonMode('send');
    const inputEl = document.getElementById('userInput');
    if (inputEl) inputEl.focus();
    msgsEl.scrollTop = msgsEl.scrollHeight;
    saveConversations();
  }
}

async function resendChatMessage(text, scene, images) {
  let providerId, modelId, modelDisplayName;
  const conv = getActiveConv();
  const hasImages = !!(images && images.length);
  if (state.autoMode) {
    const resolved = resolveModelForMessage(text, conv, hasImages);
    if (!resolved) { state.loading = false; document.getElementById('sendBtn').disabled = false; return; }
    providerId = resolved.provider;
    modelId = resolved.model;
    modelDisplayName = resolved.reason ? 'Auto · ' + resolved.reason : (modelId);
  } else {
    providerId = state.selectedProvider;
    modelId = state.selectedModel;
    modelDisplayName = modelId;
  }
  enterChat();
  await streamChatResponse(text, images || [], providerId, modelId, modelDisplayName);
}

async function handleImageRequest(prompt, originalText, scene, refImages) {
  const msgsEl = document.getElementById('messages');
  const refs = Array.isArray(refImages) ? refImages.filter(Boolean) : [];

  state.loading = true;
  document.getElementById('sendBtn').disabled = true;
  ensureChatTask(originalText);
  enterChat();

  addMsg('user', originalText, { scene, images: refs.length ? refs : undefined });
  const conv = getActiveConv();

  const pendingId = 'img-pending-' + Date.now();
  const loadingTip = refs.length
    ? ('正在按参考图生成：' + prompt)
    : ('正在生成图片：' + prompt);
  msgsEl.insertAdjacentHTML('beforeend', renderMsg({
    role: 'assistant',
    id: pendingId,
    content: `<div class="image-loading"><span class="pulse"></span>${escapeHtml(loadingTip)}</div>`,
    reasoning: true,
    pending: true,
  }));
  msgsEl.scrollTop = msgsEl.scrollHeight;
  conv.messages.push({ role: 'assistant', content: '', reasoning: true, pending: true, model: '图片生成' });

  let preferredModel = state.imageModel || 'doubao:seedream-4';
  if (refs.length && !String(preferredModel).startsWith('doubao:')) {
    preferredModel = 'doubao:seedream-4';
    showToast('转插画已切换到豆包 Seedream');
  }
  try {
    const body = { prompt, model: preferredModel, image_size: '1024x1024' };
    if (refs.length) body.images = refs.slice(0, 4);
    const res = await apiFetch(`${API}/image/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(apiErrorDetail(err, `请求失败 (${res.status})`));
    }
    const data = await res.json();
    if (!data.success) throw new Error(data.error || '图片生成失败');
    if (data.error) showToast(data.error);

    const displayUrl = imageDisplayUrl(data.image_url);
    const pending = document.getElementById(pendingId);
    if (pending) {
      const bubble = pending.querySelector('.msg-bubble');
      bubble.innerHTML = `
        <div class="msg-image">
          <img src="${escapeHtml(displayUrl)}" alt="${escapeHtml(prompt)}" loading="lazy"
               onerror="this.onerror=null;this.src='${escapeHtml(`${API}/image/proxy?url=${encodeURIComponent(data.image_url)}`)}'" />
          <div class="msg-image-caption">
            <span class="msg-image-prompt">${escapeHtml(prompt)}</span>
            <span class="msg-image-provider">${escapeHtml(data.provider || '')} · ${escapeHtml(data.model || '')}${refs.length ? ' · 参考图' : ''}</span>
          </div>
        </div>
      `;
      bubble.insertAdjacentHTML('afterend', `
        <div class="msg-actions">
          <button class="msg-action-btn" title="在新窗口打开" onclick="window.open('${escapeHtml(data.image_url)}', '_blank')">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          </button>
          <button class="msg-action-btn" title="下载图片" onclick="downloadImage('${escapeHtml(data.image_url)}','tangprop-${Date.now()}.jpg')">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>
          <button class="msg-action-btn" title="复制链接" onclick="copyToClipboard('${escapeHtml(data.image_url)}')">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2 2v1"/></svg>
          </button>
          <button class="msg-action-btn" title="重新生成" onclick="regenerateImage('${escapeHtml(prompt)}')">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          </button>
          <span class="msg-meta">图片生成 · ${escapeHtml(data.model || '')}</span>
        </div>
      `);
      const badge = pending.querySelector('.reasoning-badge');
      if (badge) badge.style.display = 'none';
    }
    const lastMsg = conv.messages[conv.messages.length - 1];
    if (lastMsg && lastMsg.role === 'assistant') {
      lastMsg.content = `[图片] ${data.image_url}`;
      lastMsg.image_url = data.image_url;
      lastMsg.image_prompt = prompt;
      lastMsg.reasoning = false;
      lastMsg.pending = false;
      lastMsg.model = `图片生成 · ${data.model || ''}`;
    }
    renderChatPreviewImage(data.image_url);
  } catch (e) {
    const pending = document.getElementById(pendingId);
    if (pending) {
      pending.querySelector('.msg-bubble').innerHTML =
        `<span style="color:var(--danger)">图片生成失败: ${escapeHtml(e.message)}</span>`;
      const badge = pending.querySelector('.reasoning-badge');
      if (badge) badge.style.display = 'none';
    }
    const lastMsg = conv.messages[conv.messages.length - 1];
    if (lastMsg && lastMsg.role === 'assistant') {
      lastMsg.content = `图片生成失败: ${e.message}`;
      lastMsg.reasoning = false;
      lastMsg.pending = false;
      lastMsg.model = '图片生成';
    }
  } finally {
    state.loading = false;
    document.getElementById('sendBtn').disabled = false;
    document.getElementById('userInput').focus();
    msgsEl.scrollTop = msgsEl.scrollHeight;
    saveConversations();
  }
}

/** 是否为「上传图后转风格 / 转插画」意图 */
function isImageEditIntent(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  return /转成|改成|变成|画成|做成|换成|生成|画一|重绘|风格化|风格|插画|动漫|漫画|卡通|二次元|水彩|油画|素描|线稿|扁平|矢量|像素|赛博|吉卜力|宫崎骏|illustration|anime|cartoon|comic|watercolor|oil\s*paint|sketch|styliz/i.test(t);
}

function buildImageEditPrompt(text) {
  const t = String(text || '').trim();
  if (!t || /^(转插画|转成插画|改成插画|变成插画|做成插画)$/i.test(t)) {
    return '将参考图转换为高质量插画风格，保留主体结构与构图，线条清晰，色彩柔和，适合商业插画，不要额外文字水印';
  }
  if (/插画|illustration/i.test(t) && t.length < 40) {
    return '将参考图转换为高质量插画风格，保留主体结构与构图，线条清晰，色彩柔和。用户要求：' + t;
  }
  return '基于参考图进行图像编辑/风格转换，尽量保持主体一致。用户要求：' + t;
}

async function regenerateImage(prompt) {
  if (state.loading) return;
  await handleImageRequest(prompt, `画一张${prompt}`, state.activeScene);
}

// 下载图片
async function downloadImage(url, filename) {
  try {
    const direct = (() => { try { return new URL(url).hostname === 'image.pollinations.ai' ? url : null; } catch { return null; } })();
    const fetchUrl = direct || imageDisplayUrl(url);
    const res = await fetch(fetchUrl);
    if (!res.ok) throw new Error(String(res.status));
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);
  } catch (e) {
    // 回退：直接打开链接
    window.open(url, '_blank');
  }
}

// 复制文本到剪贴板
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('已复制到剪贴板');
  } catch (e) {
    showToast('复制失败');
  }
}

// ── Helpers ──
function handleKey(e) {
  const palette = document.getElementById('commandPalette');
  if (palette?.classList.contains('open')) {
    handleCommandKey(e, e.target);
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

// Paste image from clipboard
document.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const file = item.getAsFile();
      if (!file) continue;
      if (file.size > 5 * 1024 * 1024) {
        showToast('图片不能超过 5MB');
        continue;
      }
      const reader = new FileReader();
      reader.onload = (ev) => {
        normalizeChatImageDataUrl(ev.target.result, 1536).then(function(url) {
          if (!url) return;
          state.pendingImages.push(url);
          renderImagePreview();
          showToast('已粘贴图片');
        });
      };
      reader.readAsDataURL(file);
    }
  }
});

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 160) + 'px';
}

function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  const bd = document.getElementById('sidebarBackdrop');
  const open = !sb.classList.contains('open');
  sb.classList.toggle('open', open);
  if (bd) bd.classList.toggle('open', open);
}
function closeSidebar() {
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebarBackdrop')?.classList.remove('open');
}

// ============================================================
// Interactive Features — 按钮功能接入
// ============================================================
const APP_VERSION = '1.0';
const WORKSPACES = [
  { id: 'default', name: '默认工作空间', desc: '通用任务与对话' },
  { id: 'tangprop', name: 'TangProp 项目', desc: '产品与前端开发' },
  { id: 'personal', name: '个人项目', desc: '私人笔记与实验' },
];
const PERMISSIONS = [
  { id: 'readonly', name: '只读', desc: 'Agent 仅可读取，不可修改文件' },
  { id: 'default', name: '默认权限', desc: '可读写项目内文件' },
  { id: 'full', name: '完全授权', desc: '可执行命令与部署操作' },
];
const THINKING_LEVELS = [
  { id: 'off', name: '关闭', tokens: null },
  { id: 'low', name: '轻量', tokens: 4096 },
  { id: 'medium', name: '标准', tokens: 8192 },
  { id: 'high', name: '深度', tokens: 16384 },
];
const SLASH_COMMANDS = [
  { cmd: '/专家', desc: '打开专家中心', run: () => openExpertCenter() },
  { cmd: '/灵感', desc: '打开灵感库', run: () => openInspirationLibrary() },
  { cmd: '/agent', desc: '打开 Agent 工作台', run: () => newAgent() },
  { cmd: '/模型', desc: '选择模型', run: () => toggleModelDropdown({ stopPropagation: () => {}, currentTarget: document.getElementById('modelSelector') }) },
  { cmd: '/max', desc: '切换 Max 模式', run: () => { toggleMaxModeFromDropdown(); showToast(state.maxMode ? 'Max 模式已开启' : 'Max 模式已关闭'); } },
  { cmd: '/导出', desc: '导出当前对话', run: () => shareConversation() },
  { cmd: '/清空', desc: '清空当前对话', run: () => clearCurrentChat() },
  { cmd: '/搜索', desc: '搜索任务', run: () => openTaskSearch() },
];
const PREFS_KEY = 'tangprop-prefs';
const NOTIFY_KEY = 'tangprop-notifications';
const RATINGS_KEY = 'tangprop-ratings';
const FAVORITES_KEY = 'tangprop-model-favorites';

let voiceRecognition = null;
let voiceActiveTarget = null;
let voiceActiveBtn = null;

function initInteractiveFeatures() {
  loadUserPrefs();
  initVoiceInput();
  initInputCommands();
  initNotifications();
  updateWorkspaceLabels();
  updateThinkingLabel();
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#thinkingPopover') && !e.target.closest('#thinkingHint')) {
      document.getElementById('thinkingPopover')?.classList.remove('open');
    }
    if (!e.target.closest('#commandPalette') && !e.target.closest('#userInput') && !e.target.closest('#wbChatInput')) {
      document.getElementById('commandPalette')?.classList.remove('open');
    }
  });
}

function loadUserPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (p.workspace) state.workspace = p.workspace;
    if (p.agentPermission) state.agentPermission = p.agentPermission;
    if (p.thinkingLevel) state.thinkingLevel = p.thinkingLevel;
  } catch (e) { /* ignore */ }
}

function saveUserPrefs() {
  localStorage.setItem(PREFS_KEY, JSON.stringify({
    workspace: state.workspace,
    agentPermission: state.agentPermission,
    thinkingLevel: state.thinkingLevel,
  }));
}

function openActionPanel(title, html) {
  document.getElementById('actionPanelTitle').textContent = title;
  document.getElementById('actionPanelBody').innerHTML = html;
  document.getElementById('actionOverlay').classList.add('open');
}

function closeActionPanel() {
  document.getElementById('actionOverlay').classList.remove('open');
}

function updateWorkspaceLabels() {
  const ws = WORKSPACES.find(w => w.id === state.workspace) || WORKSPACES[0];
  const perm = PERMISSIONS.find(p => p.id === state.agentPermission) || PERMISSIONS[1];
  const wl = document.getElementById('workspaceLabel');
  const pl = document.getElementById('permissionLabel');
  if (wl) wl.textContent = ws.name;
  if (pl) pl.textContent = perm.name;
}

function openWorkspacePanel() {
  openActionPanel('选择工作空间', WORKSPACES.map(w => `
    <div class="action-list-item ${w.id === state.workspace ? 'selected' : ''}" onclick="selectWorkspace('${w.id}')">
      <div><div>${escapeHtml(w.name)}</div><div class="meta">${escapeHtml(w.desc)}</div></div>
      ${w.id === state.workspace ? '<span class="badge">当前</span>' : ''}
    </div>
  `).join(''));
}

function selectWorkspace(id) {
  state.workspace = id;
  saveUserPrefs();
  updateWorkspaceLabels();
  closeActionPanel();
  showToast('已切换至：' + (WORKSPACES.find(w => w.id === id)?.name || id));
}

function openPermissionPanel() {
  openActionPanel('Agent 权限', PERMISSIONS.map(p => `
    <div class="action-list-item ${p.id === state.agentPermission ? 'selected' : ''}" onclick="selectPermission('${p.id}')">
      <div><div>${escapeHtml(p.name)}</div><div class="meta">${escapeHtml(p.desc)}</div></div>
      ${p.id === state.agentPermission ? '<span class="badge">当前</span>' : ''}
    </div>
  `).join(''));
}

function selectPermission(id) {
  state.agentPermission = id;
  saveUserPrefs();
  updateWorkspaceLabels();
  closeActionPanel();
  showToast('权限已设为：' + (PERMISSIONS.find(p => p.id === id)?.name || id));
}

function updateThinkingLabel() {
  const el = document.getElementById('thinkingLevelLabel');
  const level = THINKING_LEVELS.find(t => t.id === state.thinkingLevel) || THINKING_LEVELS[2];
  if (el) el.textContent = level.name;
}

function toggleThinkingPopover(e) {
  e.stopPropagation();
  const pop = document.getElementById('thinkingPopover');
  const hint = document.getElementById('thinkingHint');
  if (!pop || !hint) return;
  const open = pop.classList.contains('open');
  if (open) { pop.classList.remove('open'); return; }
  const rect = hint.getBoundingClientRect();
  pop.style.left = rect.left + 'px';
  pop.style.top = (rect.top - 8) + 'px';
  pop.style.transform = 'translateY(-100%)';
  pop.innerHTML = THINKING_LEVELS.map(t => `
    <div class="thinking-option ${t.id === state.thinkingLevel ? 'active' : ''}" onclick="selectThinkingLevel('${t.id}')">
      <span>${escapeHtml(t.name)}</span>
      ${t.id === state.thinkingLevel ? '✓' : ''}
    </div>
  `).join('');
  pop.classList.add('open');
}

function selectThinkingLevel(id) {
  state.thinkingLevel = id;
  saveUserPrefs();
  updateThinkingLabel();
  document.getElementById('thinkingPopover')?.classList.remove('open');
  const level = THINKING_LEVELS.find(t => t.id === id);
  showToast('思考强度：' + (level?.name || id));
}

function loadNotifications() {
  try {
    const raw = localStorage.getItem(NOTIFY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}

function saveNotifications(list) {
  localStorage.setItem(NOTIFY_KEY, JSON.stringify(list));
}

function addNotification(title, body, read = false) {
  const list = loadNotifications();
  list.unshift({ id: Date.now(), title, body, time: new Date().toLocaleString(), read });
  saveNotifications(list.slice(0, 30));
  updateNotifyBadge();
}

function initNotifications() {
  const list = loadNotifications();
  if (!list.length) {
    addNotification('欢迎使用 TangProp', '你可以从专家中心选择领域助手，或使用 @ / 指令快速操作。', true);
  }
  updateNotifyBadge();
}

function updateNotifyBadge() {
  const btn = document.getElementById('notifyBtn');
  if (!btn) return;
  const unread = loadNotifications().filter(n => !n.read).length;
  btn.classList.toggle('has-notify', unread > 0);
}

function openNotifications() {
  const list = loadNotifications();
  list.forEach(n => { n.read = true; });
  saveNotifications(list);
  updateNotifyBadge();
  openActionPanel('通知', list.length ? list.map(n => `
    <div class="action-list-item" style="cursor:default;flex-direction:column;align-items:flex-start;">
      <div style="font-weight:600;font-size:13px;">${escapeHtml(n.title)}</div>
      <div class="meta">${escapeHtml(n.body)}</div>
      <div class="meta" style="margin-top:4px;">${escapeHtml(n.time || '')}</div>
    </div>
  `).join('') : '<div class="action-empty">暂无通知</div>');
}

function openCustomModelPanel() {
  closeModelDropdown();
  const providerOpts = state.providers.map(p =>
    `<option value="${p.id}">${escapeHtml(p.name)}</option>`
  ).join('');
  openActionPanel('配置常用模型', `
    <p style="font-size:13px;color:var(--text-secondary);margin-bottom:10px;">保存常用模型组合，方便快速切换。</p>
    <div style="margin-bottom:10px;">
      <div class="settings-label">Provider</div>
      <select id="customModelProvider" style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--glass-border);background:var(--surface-2);color:var(--text);">${providerOpts}</select>
    </div>
    <div style="margin-bottom:10px;">
      <div class="settings-label">Model ID</div>
      <input id="customModelId" class="action-search-input" style="margin:0;" placeholder="如 glm-4-flash">
    </div>
    <div class="action-btn-row">
      <button class="action-btn secondary" onclick="closeActionPanel()">取消</button>
      <button class="action-btn primary" onclick="saveCustomModelFavorite()">保存并选用</button>
    </div>
    <div id="favoritesList" style="margin-top:16px;"></div>
  `);
  renderModelFavorites();
}

function loadModelFavorites() {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}

function renderModelFavorites() {
  const el = document.getElementById('favoritesList');
  if (!el) return;
  const favs = loadModelFavorites();
  if (!favs.length) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="settings-label">已保存</div>' + favs.map((f, i) => `
    <div class="action-list-item" onclick="applyModelFavorite(${i})">
      <div><div>${escapeHtml(f.label || f.model)}</div><div class="meta">${escapeHtml(f.provider)}/${escapeHtml(f.model)}</div></div>
    </div>
  `).join('');
}

function saveCustomModelFavorite() {
  const provider = document.getElementById('customModelProvider')?.value;
  const model = document.getElementById('customModelId')?.value?.trim();
  if (!provider || !model) { showToast('请填写完整'); return; }
  const favs = loadModelFavorites();
  favs.unshift({ provider, model, label: model });
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(favs.slice(0, 8)));
  selectModel(provider, model);
  closeActionPanel();
  showToast('已保存并切换至 ' + model);
}

function applyModelFavorite(index) {
  const fav = loadModelFavorites()[index];
  if (!fav) return;
  selectModel(fav.provider, fav.model);
  closeActionPanel();
  showToast('已切换至 ' + fav.model);
}

function loadRatings() {
  try {
    const raw = localStorage.getItem(RATINGS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) { return {}; }
}

function openForwardPanel() {
  const text = state.forwardMessageText;
  if (!text) return;
  const others = state.conversations.filter(c => c.id !== state.activeConv);
  let html = '';
  if (others.length) {
    html = others.map(c => `
      <div class="action-list-item" onclick="forwardToConv('${c.id}')">
        <div><div>${escapeHtml(c.title)}</div><div class="meta">${escapeHtml((c.messages || []).slice(-1)[0]?.content?.slice(0, 40) || '空')}</div></div>
      </div>
    `).join('');
    html += '<div class="action-btn-row"><button class="action-btn secondary" id="forwardCopyBtn">仅复制</button></div>';
  } else {
    html = '<div class="action-empty">没有其他对话可转发</div><div class="action-btn-row"><button class="action-btn primary" id="forwardCopyBtn">复制消息</button></div>';
  }
  openActionPanel('转发到其他对话', html);
  setTimeout(() => {
    document.getElementById('forwardCopyBtn')?.addEventListener('click', () => {
      copyToClipboard(text);
      closeActionPanel();
    });
  }, 0);
}

function forwardToConv(convId) {
  const text = state.forwardMessageText;
  if (!text) return;
  const conv = state.conversations.find(c => c.id === convId);
  if (!conv) return;
  conv.messages.push({ role: 'user', content: '[转发]\n' + text });
  conv.time = '刚刚';
  saveConversations();
  renderTasks();
  closeActionPanel();
  showToast('已转发至：' + conv.title);
  state.forwardMessageText = null;
}

function clearCurrentChat() {
  const conv = getActiveConv();
  conv.messages = [];
  saveConversations();
  const msgsEl = document.getElementById('messages');
  if (msgsEl) msgsEl.innerHTML = '';
  renderChatPreviewEmpty();
  showToast('对话已清空');
}

function initVoiceInput() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return;
  voiceRecognition = new SpeechRecognition();
  voiceRecognition.lang = 'zh-CN';
  voiceRecognition.interimResults = true;
  voiceRecognition.continuous = false;
  voiceRecognition.onresult = (e) => {
    let transcript = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) transcript += e.results[i][0].transcript;
    }
    if (!transcript && e.results.length) {
      transcript = e.results[e.results.length - 1][0].transcript;
    }
    const input = voiceActiveTarget;
    if (input && transcript) {
      const sep = input.value && !input.value.endsWith(' ') ? ' ' : '';
      input.value = input.value + sep + transcript;
      input.dispatchEvent(new Event('input'));
      if (input.id === 'userInput') autoResize(input);
      else if (input.id === 'wbChatInput') autoResizeWbInput(input);
    }
  };
  voiceRecognition.onend = () => stopVoiceUI();
  voiceRecognition.onerror = (e) => {
    stopVoiceUI();
    if (e.error !== 'aborted') showToast('语音识别失败：' + (e.error || '未知'));
  };
}

function stopVoiceUI() {
  document.querySelectorAll('.tool-btn.recording').forEach(b => b.classList.remove('recording'));
  voiceActiveTarget = null;
  voiceActiveBtn = null;
}

function toggleVoiceInput(btn, targetId) {
  if (!voiceRecognition) {
    showToast('当前浏览器不支持语音输入（请使用 Chrome / Edge）');
    return;
  }
  if (btn.classList.contains('recording')) {
    voiceRecognition.stop();
    return;
  }
  stopVoiceUI();
  voiceActiveTarget = document.getElementById(targetId);
  voiceActiveBtn = btn;
  btn.classList.add('recording');
  showToast('正在聆听… 再次点击停止');
  try { voiceRecognition.start(); } catch (e) {
    stopVoiceUI();
    showToast('无法启动麦克风，请检查权限');
  }
}

function initInputCommands() {
  ['userInput', 'wbChatInput'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => checkInputCommands(el));
    el.addEventListener('keydown', (e) => handleCommandKey(e, el));
  });
}

function checkInputCommands(input) {
  const val = input.value;
  const pos = input.selectionStart ?? val.length;
  const before = val.slice(0, pos);
  const slashMatch = before.match(/\/([\w\u4e00-\u9fa5]*)$/);
  const atMatch = before.match(/@([\w\u4e00-\u9fa5]*)$/);
  if (slashMatch) showCommandPalette(input, slashMatch[1], 'slash');
  else if (atMatch) showCommandPalette(input, atMatch[1], 'at');
  else document.getElementById('commandPalette')?.classList.remove('open');
}

function showCommandPalette(input, query, mode) {
  const palette = document.getElementById('commandPalette');
  if (!palette) return;
  state.commandPaletteInput = input;
  state.commandPaletteMode = mode;
  state.commandPaletteQuery = query;

  let items = [];
  if (mode === 'slash') {
    const q = query.toLowerCase();
    items = SLASH_COMMANDS.filter(c => c.cmd.slice(1).includes(q) || c.desc.includes(query));
  } else {
    const q = query.toLowerCase();
    items = state.conversations
      .filter(c => !q || (c.title || '').toLowerCase().includes(q))
      .slice(0, 8)
      .map(c => ({
        cmd: '@' + c.title,
        desc: (c.messages || []).slice(-1)[0]?.content?.slice(0, 30) || '引用此对话',
        run: () => applyAtReference(c),
      }));
  }
  if (!items.length) {
    palette.classList.remove('open');
    return;
  }
  palette.innerHTML = items.map((it, i) => `
    <div class="command-item ${i === 0 ? 'active' : ''}" data-idx="${i}" onclick="executeCommandItem(${i})">
      <span class="cmd">${escapeHtml(it.cmd)}</span>
      <span class="desc">${escapeHtml(it.desc)}</span>
    </div>
  `).join('');
  state.commandPaletteItems = items;

  const rect = input.getBoundingClientRect();
  palette.style.left = rect.left + 'px';
  palette.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
  palette.style.top = 'auto';
  palette.classList.add('open');
}

function executeCommandItem(idx) {
  const items = state.commandPaletteItems || [];
  const item = items[idx];
  if (!item) return;
  const input = state.commandPaletteInput;
  if (input && state.commandPaletteMode === 'slash') {
    const val = input.value;
    const pos = input.selectionStart ?? val.length;
    const before = val.slice(0, pos).replace(/\/[\w\u4e00-\u9fa5]*$/, '');
    input.value = before;
  }
  document.getElementById('commandPalette')?.classList.remove('open');
  item.run();
}

function applyAtReference(conv) {
  const input = state.commandPaletteInput;
  if (!input) return;
  const val = input.value;
  const pos = input.selectionStart ?? val.length;
  const before = val.slice(0, pos).replace(/@[\w\u4e00-\u9fa5]*$/, '');
  const after = val.slice(pos);
  const ref = `@${conv.title} `;
  input.value = before + ref + after;
  input.focus();
  input.dispatchEvent(new Event('input'));
  document.getElementById('commandPalette')?.classList.remove('open');
  showToast('已引用：' + conv.title);
}

function handleCommandKey(e, input) {
  const palette = document.getElementById('commandPalette');
  if (!palette?.classList.contains('open')) return;
  const items = palette.querySelectorAll('.command-item');
  let active = palette.querySelector('.command-item.active');
  let idx = active ? parseInt(active.dataset.idx, 10) : 0;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    idx = Math.min(idx + 1, items.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    idx = Math.max(idx - 1, 0);
  } else if (e.key === 'Tab' || (e.key === 'Enter' && palette.classList.contains('open'))) {
    if (state.commandPaletteMode === 'slash' || state.commandPaletteMode === 'at') {
      e.preventDefault();
      executeCommandItem(idx);
      return;
    }
  } else if (e.key === 'Escape') {
    palette.classList.remove('open');
    return;
  } else {
    return;
  }
  items.forEach((el, i) => el.classList.toggle('active', i === idx));
}

// ── Start ──
init();
