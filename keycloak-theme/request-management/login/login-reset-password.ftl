<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=true displayInfo=true; section>
    <#if section = "header">
        ลืมรหัสผ่าน?
    <#elseif section = "form">
        <p class="subtitle">กรอกอีเมลบริษัทของคุณ เราจะส่งลิงก์ตั้งรหัสผ่านใหม่ไปให้</p>

        <form id="kc-reset-password-form" action="${url.loginAction}" method="post">
            <div class="field">
                <label for="username">อีเมลบริษัท</label>
                <div class="input-wrap">
                    <span class="input-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
                    </span>
                    <input type="text" id="username" name="username"
                           placeholder="yourname@osd.co.th"
                           value="${(auth.attemptedUsername!'')}"
                           autofocus autocomplete="username"
                           aria-invalid="<#if messagesPerField.existsError('username')>true</#if>"/>
                </div>
                <#if messagesPerField.existsError('username')>
                    <span class="field-error">${kcSanitize(messagesPerField.get('username'))?no_esc}</span>
                </#if>
            </div>

            <button class="btn-primary" type="submit">
                ส่งลิงก์ตั้งรหัสผ่านใหม่
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>
            </button>
            <a class="btn-secondary" href="${url.loginUrl}">กลับไปหน้าเข้าสู่ระบบ</a>
        </form>
    <#elseif section = "info">
        <#-- Nothing further — the mail itself carries the next step. -->
    </#if>
</@layout.registrationLayout>
