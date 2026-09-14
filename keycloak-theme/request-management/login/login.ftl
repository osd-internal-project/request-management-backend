<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('username','password') displayInfo=realm.password && realm.registrationAllowed && !registrationDisabled??; section>
    <#if section = "header">
        ยินดีต้อนรับ <span class="wave">👋</span>
    <#elseif section = "form">
        <p class="subtitle">เข้าสู่ระบบเพื่อเริ่มต้นวันทำงาน</p>

        <#if realm.password>
            <form id="kc-form-login" onsubmit="document.getElementById('kc-login').disabled = true; return true;" action="${url.loginAction}" method="post">
                <#if !usernameHidden??>
                    <div class="field">
                        <label for="username">อีเมลบริษัท</label>
                        <div class="input-wrap">
                            <span class="input-icon">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
                            </span>
                            <input tabindex="1" id="username" name="username" type="text"
                                   value="${(login.username!'')}"
                                   placeholder="yourname@osd.co.th"
                                   autofocus autocomplete="username"
                                   aria-invalid="<#if messagesPerField.existsError('username','password')>true</#if>"/>
                        </div>
                    </div>
                </#if>

                <div class="field">
                    <div class="label-row">
                        <label for="password">รหัสผ่าน</label>
                        <#if realm.resetPasswordAllowed>
                            <a tabindex="5" class="forgot" href="${url.loginResetCredentialsUrl}">ลืมรหัสผ่าน?</a>
                        </#if>
                    </div>
                    <div class="input-wrap">
                        <span class="input-icon">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                        </span>
                        <input tabindex="2" id="password" name="password" type="password"
                               placeholder="••••••••"
                               autocomplete="current-password"
                               aria-invalid="<#if messagesPerField.existsError('username','password')>true</#if>"/>
                        <button type="button" class="eye" id="osd-toggle-pw" aria-label="แสดงรหัสผ่าน" tabindex="-1">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
                        </button>
                    </div>
                    <#if messagesPerField.existsError('username','password')>
                        <span class="field-error" aria-live="polite">${kcSanitize(messagesPerField.getFirstError('username','password'))?no_esc}</span>
                    </#if>
                </div>

                <#if realm.rememberMe && !usernameHidden??>
                    <label class="remember">
                        <input tabindex="3" id="rememberMe" name="rememberMe" type="checkbox" <#if login.rememberMe??>checked</#if>/>
                        จดจำฉันไว้ในระบบ
                    </label>
                </#if>

                <input type="hidden" id="id-hidden-input" name="credentialId" <#if auth.selectedCredential?has_content>value="${auth.selectedCredential}"</#if>/>

                <button tabindex="4" id="kc-login" class="btn-primary" type="submit">
                    เข้าสู่ระบบ
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>
                </button>
            </form>

            <script>
                (function () {
                    var toggle = document.getElementById('osd-toggle-pw');
                    if (toggle) toggle.addEventListener('click', function () {
                        var p = document.getElementById('password');
                        p.type = p.type === 'password' ? 'text' : 'password';
                        toggle.classList.toggle('eye-on');
                    });
                })();
            </script>
        </#if>
    <#elseif section = "info">
        <#if realm.password && realm.registrationAllowed && !registrationDisabled??>
            <p>${msg("noAccount")} <a tabindex="6" href="${url.registrationUrl}">${msg("doRegister")}</a></p>
        </#if>
    </#if>
</@layout.registrationLayout>
