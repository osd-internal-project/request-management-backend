"""
Generate external-service's CRM controllers from core-service's.

The transformation is one rule, applied mechanically, so the two sides cannot
diverge by accident in *shape*:

  @Controller('customers')            -> @Controller('crm/customers')
  @Permissions('crm.customer.read')   -> @Permissions('integration.crm.customer.read')
                                         @ActingPermissions('crm.customer.read')

plus the class-level machine decorators and a rewritten import block. The
handler bodies are untouched: they delegate to the same injected services.

`crm-route-parity.spec.ts` then asserts the 1:1 correspondence holds, which is
what keeps a route added to a screen from being silently missing here.
"""
import pathlib, re

SRC = pathlib.Path('services/core-service/src/crm')
DST = pathlib.Path('services/external-service/src/crm')

# web permission -> the machine gate that fronts it
ROBOT = {
    'crm.customer.read':   'integration.crm.customer.read',
    'crm.customer.manage': 'integration.crm.customer.manage',
    'crm.sales.read':      'integration.crm.sales.read',
    'crm.sales.manage':    'integration.crm.sales.manage',
    'admin.crm.manage':    'integration.crm.admin.manage',
}

FILES = {
    'customers.controller.ts':  [('customers', 'crm/customers')],
    'crm-admin.controller.ts':  [('admin/crm', 'crm/admin')],
    'quotations.controller.ts': [('quotations', 'crm/quotations')],
    'sales.controllers.ts':     [('leads', 'crm/leads'),
                                 ('opportunities', 'crm/opportunities'),
                                 ('sale-orders', 'crm/sale-orders')],
}

HEADER = '''/**
 * GENERATED from `services/core-service/src/crm/{src}` — do not hand-edit.
 *
 * Regenerate with `yarn crm:gen`. The generator applies one rule: each route
 * keeps its handler and its DTOs, its `@Permissions('crm.…')` becomes the
 * matching `integration.crm.…` machine gate, and the permission it used to
 * declare becomes `@ActingPermissions`, checked after the acting-user swap.
 *
 * Two gates, two questions — see `ActingPermissions` in `libs/share`:
 * `@Permissions` asks whether this *integration* may call the route at all,
 * `@ActingPermissions` asks whether the *person* in `X-Acting-User` may do it.
 * Before the second one existed, exposing CRM here would have let a machine
 * act as somebody who lacks the permission, because CRM enforces `crm.*` on
 * its controllers and `PolicyGuard` has already run by the time the swap
 * happens.
 *
 * `crm-route-parity.spec.ts` fails if a route exists on one side and not the
 * other, or if a pair's permissions stop corresponding.
 */
'''

def rewrite_imports(body, src_name):
    # every local import resolves out of core-service's public surface now
    body = re.sub(r"import \{([^}]*)\} from '\./(?!dto/)[^']+';", '', body)
    body = re.sub(r"import \{([^}]*)\} from '\./dto/[^']+';", '', body)
    body = re.sub(r"import \{ (\w+) \} from '\./[^']+';", '', body)
    return body

for src_name, prefixes in FILES.items():
    src = (SRC / src_name).read_text()

    # --- split off the import block; we rewrite it wholesale ---
    last = max(src.rfind("} from './dto/"), src.rfind("} from '@request-management/share';"),
               src.rfind("from './"))
    end = src.index('\n', src.index(';', last)) + 1
    head, body = src[:end], src[end:]

    # collect what the file imports from @nestjs/common and its DTOs, verbatim
    nest_common = re.search(r"import \{([^}]*)\} from '@nestjs/common';", head).group(1)
    dto_names = []
    for m in re.finditer(r"import \{([^}]*)\} from '\./dto/[^']+';", head):
        dto_names += [n.strip() for n in m.group(1).split(',') if n.strip()]
    for m in re.finditer(r"import \{ (\w+) \} from '\./dto/[^']+';", head):
        dto_names.append(m.group(1))
    services = []
    for m in re.finditer(r"import \{ (\w+) \} from '\./(?!dto/)[^']+';", head):
        services.append(m.group(1))
    share = re.search(r"import \{([^}]*)\} from '@request-management/share';", head).group(1)
    share_names = sorted({n.strip() for n in share.split(',') if n.strip()}
                         | {'ActingPermissions', 'ActingPolicyGuard',
                            'Permissions', 'ServiceAccountOnly'})

    core_names = sorted(set(services) | set(dto_names))

    out = HEADER.format(src=src_name)
    # UseGuards is always needed here: the class-level pair is what applies
    # the acting-user swap and the second gate.
    common = sorted({n.strip() for n in nest_common.split(',') if n.strip()} | {'UseGuards'})
    out += "import {\n%s,\n} from '@nestjs/common';\n" % ',\n'.join('  ' + n for n in common)
    # ApiOperation ตามมาก็ต่อเมื่อ body ที่ก๊อปมาใช้จริง — import ที่ไม่ได้ใช้ทำ lint แตก
    swagger = ['ApiBearerAuth', 'ApiHeader']
    if '@ApiOperation(' in src:
        swagger.append('ApiOperation')
    swagger.append('ApiTags')
    one_line = "import { %s } from '@nestjs/swagger';" % ', '.join(swagger)
    out += (one_line + '\n') if len(one_line) <= 80 else (
        "import {\n%s,\n} from '@nestjs/swagger';\n" % ',\n'.join('  ' + n for n in swagger))
    out += "import {\n%s,\n} from '@request-management/share';\n" % ',\n'.join('  ' + n for n in share_names)
    out += "import type { Principal } from '@request-management/share';\n"
    out += "import {\n%s,\n} from '@request-management/core-service';\n" % ',\n'.join('  ' + n for n in core_names)
    out += "import {\n  ACTING_USER_HEADER_LABEL,\n  ActingUserGuard,\n} from '../auth/acting-user.guard';\n"

    # --- the body: route prefixes, the two gates, class names ---
    for old, new in prefixes:
        body = body.replace(f"@Controller('{old}')", f"@Controller('{new}')")

    body = re.sub(r"( *)@Permissions\('([\w.]+)'\)",
                  lambda m: f"{m.group(1)}@Permissions('{ROBOT[m.group(2)]}')\n{m.group(1)}@ActingPermissions('{m.group(2)}')"
                            if m.group(2) in ROBOT else m.group(0),
                  body)

    # class-level machine decorators, on every exported controller class
    body = re.sub(
        r"@ApiTags\('([^']+)'\)\n@ApiBearerAuth\(\)\n",
        lambda m: ("@ApiTags('crm')\n@ApiBearerAuth()\n"
                   "@ApiHeader({\n  name: ACTING_USER_HEADER_LABEL,\n  required: true,\n"
                   "  description: 'อีเมลของผู้ใช้ที่ทำรายการ — ระบบจะทำงานในนามของคนนี้',\n})\n"),
        body)
    body = re.sub(r"(@Controller\('crm/[^']+'\)\n)",
                  r"\1@ServiceAccountOnly()\n@UseGuards(ActingUserGuard, ActingPolicyGuard)\n",
                  body)
    body = re.sub(r"export class (\w+)Controller", r"export class External\1Controller", body)

    dst_name = (src_name.replace('.controllers.ts', '')
                        .replace('.controller.ts', ''))
    (DST / f"{dst_name}.controller.ts").write_text(out + body)
    print('wrote', DST / f"{dst_name}.controller.ts")
