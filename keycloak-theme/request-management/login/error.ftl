<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=false displayInfo=false; section>
    <#if section = "header">
        เกิดข้อผิดพลาด
    <#elseif section = "form">
        <div class="alert alert-error">
            <#if message?has_content>
                ${kcSanitize(message.summary)?no_esc}
            <#else>
                ไม่สามารถดำเนินการต่อได้ในขณะนี้
            </#if>
        </div>
        <#if skipLink?? && client?? && client.baseUrl?has_content>
            <a class="btn-secondary" href="${client.baseUrl}">กลับไปที่แอปพลิเคชัน</a>
        <#else>
            <a class="btn-secondary" href="${url.loginUrl}">กลับไปหน้าเข้าสู่ระบบ</a>
        </#if>
    </#if>
</@layout.registrationLayout>
