<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=true displayInfo=false; section>
    <#if section = "header">
        สร้างบัญชีใหม่
    <#elseif section = "form">
        <p class="subtitle">กรอกข้อมูลเพื่อเริ่มใช้งาน Request Management</p>

        <form id="kc-register-form" action="${url.registrationAction}" method="post">
            <div class="field">
                <label for="firstName">ชื่อ</label>
                <div class="input-wrap">
                    <span class="input-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                    </span>
                    <input type="text" id="firstName" name="firstName"
                           value="${(register.formData.firstName!'')}"
                           aria-invalid="<#if messagesPerField.existsError('firstName')>true</#if>"/>
                </div>
                <#if messagesPerField.existsError('firstName')>
                    <span class="field-error">${kcSanitize(messagesPerField.get('firstName'))?no_esc}</span>
                </#if>
            </div>

            <div class="field">
                <label for="lastName">นามสกุล</label>
                <div class="input-wrap">
                    <span class="input-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                    </span>
                    <input type="text" id="lastName" name="lastName"
                           value="${(register.formData.lastName!'')}"
                           aria-invalid="<#if messagesPerField.existsError('lastName')>true</#if>"/>
                </div>
                <#if messagesPerField.existsError('lastName')>
                    <span class="field-error">${kcSanitize(messagesPerField.get('lastName'))?no_esc}</span>
                </#if>
            </div>

            <div class="field">
                <label for="email">อีเมลบริษัท</label>
                <div class="input-wrap">
                    <span class="input-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
                    </span>
                    <input type="text" id="email" name="email"
                           placeholder="yourname@osd.co.th"
                           value="${(register.formData.email!'')}"
                           autocomplete="email"
                           aria-invalid="<#if messagesPerField.existsError('email')>true</#if>"/>
                </div>
                <#if messagesPerField.existsError('email')>
                    <span class="field-error">${kcSanitize(messagesPerField.get('email'))?no_esc}</span>
                </#if>
            </div>

            <#if !realm.registrationEmailAsUsername>
                <div class="field">
                    <label for="username">ชื่อผู้ใช้</label>
                    <div class="input-wrap">
                        <input type="text" id="username" name="username"
                               value="${(register.formData.username!'')}"
                               autocomplete="username"
                               aria-invalid="<#if messagesPerField.existsError('username')>true</#if>"/>
                    </div>
                    <#if messagesPerField.existsError('username')>
                        <span class="field-error">${kcSanitize(messagesPerField.get('username'))?no_esc}</span>
                    </#if>
                </div>
            </#if>

            <#if passwordRequired??>
                <div class="field">
                    <label for="password">รหัสผ่าน</label>
                    <div class="input-wrap">
                        <span class="input-icon">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                        </span>
                        <input type="password" id="password" name="password"
                               autocomplete="new-password"
                               aria-invalid="<#if messagesPerField.existsError('password','password-confirm')>true</#if>"/>
                    </div>
                    <#if messagesPerField.existsError('password')>
                        <span class="field-error">${kcSanitize(messagesPerField.get('password'))?no_esc}</span>
                    </#if>
                </div>

                <div class="field">
                    <label for="password-confirm">ยืนยันรหัสผ่าน</label>
                    <div class="input-wrap">
                        <span class="input-icon">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                        </span>
                        <input type="password" id="password-confirm" name="password-confirm"
                               autocomplete="new-password"
                               aria-invalid="<#if messagesPerField.existsError('password-confirm')>true</#if>"/>
                    </div>
                    <#if messagesPerField.existsError('password-confirm')>
                        <span class="field-error">${kcSanitize(messagesPerField.get('password-confirm'))?no_esc}</span>
                    </#if>
                </div>
            </#if>

            <button class="btn-primary" type="submit">
                สร้างบัญชี
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>
            </button>
        </form>
    <#elseif section = "info">
        <p>มีบัญชีอยู่แล้ว? <a href="${url.loginUrl}">เข้าสู่ระบบ</a></p>
    </#if>
</@layout.registrationLayout>
