<#macro registrationLayout bodyClass="" displayInfo=false displayMessage=true displayRequiredFields=false>
<!DOCTYPE html>
<html lang="th">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow">
    <meta name="color-scheme" content="light">
    <title>${msg("loginTitle", (realm.displayName!'OSD'))}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Thai:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <#if properties.styles?has_content>
        <#list properties.styles?split(' ') as style>
            <link href="${url.resourcesPath}/${style}" rel="stylesheet"/>
        </#list>
    </#if>
</head>
<body class="osd-login ${bodyClass}">
<div class="split">

    <#-- ── Left: brand panel ─────────────────────────────────────────── -->
    <aside class="brand">
        <div class="brand-inner">
            <span class="badge"><span class="badge-dot"></span>v3.0 · 2026 Edition</span>

            <h2 class="brand-title">ระบบบริหารงาน<br><span class="brand-title-accent">ครบวงจร</span></h2>
            <p class="brand-desc">แพลตฟอร์มกลางสำหรับพนักงาน OSD ทุกแผนก เข้าถึงระบบตามสิทธิ์ของคุณ</p>

            <ul class="features">
                <li>
                    <span class="feature-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 12h6M9 16h4"/></svg>
                    </span>
                    Task &amp; Project Management พร้อม Kanban Board
                </li>
                <li>
                    <span class="feature-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                    </span>
                    HR, Finance, Sales CRM และ IT Systems
                </li>
                <li>
                    <span class="feature-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V4M8 4h8"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/><path d="M9 17h6"/></svg>
                    </span>
                    OSD AI Companion ผู้ช่วย AI ส่วนตัว
                </li>
            </ul>

            <div class="stats">
                <div class="stat"><span class="stat-num">142</span><span class="stat-label">พนักงาน</span></div>
                <div class="stat"><span class="stat-num">7+</span><span class="stat-label">ระบบหลัก</span></div>
                <div class="stat"><span class="stat-num">50+</span><span class="stat-label">ฟีเจอร์</span></div>
            </div>
        </div>

        <div class="float-cards" aria-hidden="true">
            <div class="float-card fc-1">
                <div class="fc-label"><span class="fc-ico fc-ico-blue">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
                </span>งานวันนี้</div>
                <div class="fc-value">5 งาน</div>
                <div class="fc-sub">3 เสร็จแล้ว</div>
            </div>
            <div class="float-card fc-2">
                <div class="fc-label"><span class="fc-ico fc-ico-violet">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
                </span>การแจ้งเตือน</div>
                <div class="fc-value">12 ใหม่</div>
                <div class="fc-sub">3 ด่วน</div>
            </div>
            <div class="float-card fc-3">
                <div class="fc-label"><span class="fc-ico fc-ico-cyan">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V4M8 4h8"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/></svg>
                </span>OSD AI Companion</div>
                <div class="fc-value">พร้อมใช้งาน</div>
                <div class="fc-sub">ผู้ช่วย AI ส่วนตัว</div>
            </div>
        </div>
    </aside>

    <#-- ── Right: form panel ─────────────────────────────────────────── -->
    <main class="panel">
        <div class="panel-inner">
            <div class="logo">OSD</div>
            <h1 class="headline"><#nested "header"></h1>

            <#if displayMessage && message?has_content && (message.type != 'warning' || !isAppInitiatedAction??)>
                <div class="alert alert-${message.type}">
                    <span>${kcSanitize(message.summary)?no_esc}</span>
                </div>
            </#if>

            <div class="content">
                <#nested "form">
            </div>

            <#if auth?? && auth.showTryAnotherWayLink()>
                <form class="try-another" action="${url.loginAction}" method="post">
                    <input type="hidden" name="tryAnotherWay" value="on"/>
                    <button type="submit" class="link-btn">${msg("doTryAnotherWay")}</button>
                </form>
            </#if>

            <#nested "socialProviders">

            <#if displayInfo>
                <div class="info"><#nested "info"></div>
            </#if>
        </div>
    </main>
</div>
</body>
</html>
</#macro>
