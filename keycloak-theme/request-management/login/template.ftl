<#macro registrationLayout bodyClass="" displayInfo=false displayMessage=true displayRequiredFields=false>
<!DOCTYPE html>
<html lang="${locale.currentLanguageTag}">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${properties.portalBrowserTitle!'Request Management | เข้าสู่ระบบ'}</title>
    <link rel="icon" href="${url.resourcesPath}/img/favicon.svg">
    <link rel="stylesheet" href="${url.resourcesPath}/css/styles.css">
</head>
<body class="login-page ${bodyClass}">
    <div class="login-shell">
        <div class="login-card">
            <div class="login-brand">
                <img src="${url.resourcesPath}/img/logo.svg" alt="${properties.portalName!'Request Management'}" class="logo" onerror="this.style.display='none'">
                <span class="logo-text">${properties.portalName!'Request Management'}</span>
            </div>

            <#if realm.internationalizationEnabled && locale.supported?size gt 1>
                <div class="locale-switch">
                    <#list locale.supported as l>
                        <a href="${l.url}" class="locale-link<#if l.languageTag == locale.currentLanguageTag> active</#if>">${l.label}</a>
                    </#list>
                </div>
            </#if>

            <div class="login-header">
                <#nested "header">
            </div>

            <#if displayMessage && message?has_content>
                <div class="alert alert-${message.type}" aria-live="polite">
                    ${kcSanitize(message.summary)?no_esc}
                </div>
            </#if>

            <#nested "form">

            <#if displayInfo>
                <div class="login-info">
                    <#nested "info">
                </div>
            </#if>
        </div>

        <p class="login-footer">© ${.now?string('yyyy')} OSD — Request Management</p>
    </div>
</body>
</html>
</#macro>
