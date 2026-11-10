'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GraphStore } = require('../src/graphStore');
const { extractFrameworkFacts, MAX_SOURCE_CHARS } = require('../src/frameworks');
const { frameworkCouplings, dynamicRiskFor } = require('../src/frameworkImpact');
const { tempDir, parsedSymbols } = require('./helpers');

function withStore(fn) {
  const { dir, cleanup } = tempDir();
  const store = new GraphStore(dir);
  try {
    return fn(store, dir);
  } finally {
    store.close();
    cleanup();
  }
}

const facts = (relPath, source) => extractFrameworkFacts(relPath, relPath.slice(relPath.lastIndexOf('.')), source);
const byRole = (list, role) => list.filter((f) => f.role === role);
const details = (list, role) => byRole(list, role).map((f) => f.detail);
const parsed = (list, role) => byRole(list, role).map((f) => JSON.parse(f.detail));

// --- Angular ---------------------------------------------------------------

const USER_CARD_TS = `
import { Component, Input, inject } from '@angular/core';
import { UserService } from './user.service';

// @Component({ selector: 'app-commented-out' })
@Component({
  selector: 'app-user-card',
  templateUrl: './user-card.component.html',
  styleUrls: ['./user-card.component.css']
})
export class UserCardComponent {
  private store = inject(AuthStore);
  constructor(private users: UserService, @Inject(API_URL) private url: string, private readonly http: HttpClient, name: string) {}
}
`;

test('Angular component: selector/templateUrl detail, constructor and inject() injection', () => {
  const list = facts('src/user-card.component.ts', USER_CARD_TS);
  assert.deepEqual(parsed(list, 'component'), [{ selector: 'app-user-card', templateUrl: './user-card.component.html' }]);
  assert.equal(byRole(list, 'component')[0].symbolName, 'UserCardComponent');
  assert.equal(byRole(list, 'component')[0].framework, 'angular');
  assert.equal(byRole(list, 'component')[0].line, 6);
  // One fact per injected type; `string` and the commented-out component are not facts.
  assert.deepEqual(details(list, 'injects').sort(), ['API_URL', 'AuthStore', 'HttpClient', 'UserService']);
  for (const f of byRole(list, 'injects')) assert.equal(f.symbolName, 'UserCardComponent');
});

test('Angular directive, pipe, injectable and module', () => {
  const list = facts('src/app.module.ts', `
@Directive({ selector: '[appHighlight]' })
export class HighlightDirective {}

@Pipe({ name: 'truncate' })
export class TruncatePipe {}

@Injectable({ providedIn: 'root' })
export class UserService {}

@NgModule({
  declarations: [AppComponent, UserCardComponent],
  imports: [BrowserModule, RouterModule.forRoot(routes)],
  providers: [UserService, { provide: LOGGER, useClass: ConsoleLogger }],
  bootstrap: [AppComponent]
})
export class AppModule {}
`);
  assert.deepEqual(parsed(list, 'directive'), [{ selector: '[appHighlight]' }]);
  assert.deepEqual(parsed(list, 'pipe'), [{ name: 'truncate' }]);
  assert.deepEqual(parsed(list, 'service'), [{ providedIn: 'root' }]);
  assert.equal(byRole(list, 'service')[0].symbolName, 'UserService');
  const [mod] = parsed(list, 'module');
  assert.deepEqual(mod.declarations, ['AppComponent', 'UserCardComponent']);
  assert.deepEqual(mod.imports, ['BrowserModule', 'RouterModule']);
  assert.deepEqual(mod.providers, ['UserService', 'LOGGER', 'ConsoleLogger']);
  assert.equal(byRole(list, 'module')[0].symbolName, 'AppModule');
});

test('Angular routes: component, loadChildren, loadComponent; nested children are not credited to the parent', () => {
  const list = facts('src/app-routing.module.ts', `
const routes: Routes = [
  { path: '', redirectTo: 'home', pathMatch: 'full' },
  { path: 'home', component: HomeComponent },
  { path: 'admin', loadChildren: () => import('./admin/admin.module').then(m => m.AdminModule) },
  { path: 'lazy', loadComponent: () => import('./lazy.component').then(m => m.LazyComponent) },
  { path: 'shop', children: [{ path: 'cart', component: CartComponent }] }
];
`);
  const routes = parsed(list, 'route');
  assert.deepEqual(routes.find((r) => r.path === 'home'), { path: 'home', component: 'HomeComponent' });
  assert.deepEqual(routes.find((r) => r.path === 'admin'), { path: 'admin', loadChildren: 'AdminModule', importPath: './admin/admin.module' });
  assert.equal(routes.find((r) => r.path === 'lazy').loadComponent, 'LazyComponent');
  assert.deepEqual(routes.find((r) => r.path === 'cart'), { path: 'cart', component: 'CartComponent' });
  assert.equal(routes.some((r) => r.path === 'shop'), false, 'a route with no target of its own is not a route fact');
  assert.equal(routes.some((r) => r.path === ''), false, 'a redirect has no target');
});

test('Angular inline template and .html template custom elements', () => {
  const inline = facts('src/x.component.ts', `
@Component({ selector: 'app-x', template: \`<div>{{ when | date }}</div><app-user-card [u]="u"></app-user-card>\` })
export class XComponent {}
`);
  assert.deepEqual(details(inline, 'template-uses'), ['app-user-card']);
  assert.equal(byRole(inline, 'template-uses')[0].symbolName, 'XComponent');
  assert.deepEqual(details(inline, 'template-pipe'), ['date']);

  const html = facts('src/app.component.html', `
<!-- <app-commented-out></app-commented-out> -->
<ng-container *ngIf="user$ | async as user">
  <app-user-card [user]="user"></app-user-card>
  <app-user-card [user]="other"></app-user-card>
  <mat-icon>home</mat-icon>
  <p>{{ price | currency:'USD' }} {{ a || b }}</p>
</ng-container>
<div class="plain"></div>
`);
  assert.deepEqual(details(html, 'template-uses'), ['app-user-card', 'mat-icon']);
  assert.deepEqual(details(html, 'template-pipe').sort(), ['async', 'currency']);
  assert.equal(byRole(html, 'template-uses')[0].symbolName, null);
  assert.equal(byRole(html, 'template-uses')[0].line, 4);
});

// --- Java ------------------------------------------------------------------

const ORDER_CONTROLLER_JAVA = `
package com.shop.web;

@RestController
@RequestMapping("/api/orders")
public class OrderController {
    @Autowired
    private OrderService orderService;

    @Inject
    private List<PaymentHandler> handlers;

    private final AuditLog audit;
    private final String label = "x";

    public OrderController(AuditLog audit) { this.audit = audit; }

    @GetMapping("/{id}")
    public Order get(@PathVariable long id) { return orderService.find(id); }

    @RequestMapping(value = "/bulk", method = RequestMethod.POST)
    public void bulk() {}

    @DeleteMapping
    public void clear() {}

    public Object reflect(String n) throws Exception {
        Class<?> c = Class.forName(n);
        return c.getDeclaredMethod("run").invoke(null);
    }
}
`;

test('Spring controller: role, injection (field, wrapper, constructor), routes with joined paths, reflection', () => {
  const list = facts('src/OrderController.java', ORDER_CONTROLLER_JAVA);
  const controller = byRole(list, 'controller');
  assert.equal(controller.length, 1);
  assert.equal(controller[0].symbolName, 'OrderController');
  assert.equal(controller[0].framework, 'spring');
  assert.deepEqual(details(list, 'injects').sort(), ['AuditLog', 'OrderService', 'PaymentHandler']);

  const routes = byRole(list, 'route').map((f) => ({ sym: f.symbolName, ...JSON.parse(f.detail) }));
  assert.deepEqual(routes.find((r) => r.sym === 'get'), { sym: 'get', method: 'GET', path: '/api/orders/{id}' });
  assert.deepEqual(routes.find((r) => r.sym === 'bulk'), { sym: 'bulk', method: 'POST', path: '/api/orders/bulk' });
  assert.deepEqual(routes.find((r) => r.sym === 'clear'), { sym: 'clear', method: 'DELETE', path: '/api/orders' });
  assert.ok(routes.some((r) => r.sym === 'OrderController' && r.path === '/api/orders'), 'class-level mapping');

  assert.deepEqual(details(list, 'dynamic').sort(), ['Class.forName', 'getDeclaredMethod']);
  assert.equal(byRole(list, 'dynamic')[0].symbolName, 'reflect');
});

test('Spring service/repository/entity/configuration/bean, Lombok constructor injection', () => {
  const list = facts('src/Billing.java', `
@Service
@RequiredArgsConstructor
public class BillingService {
    private final InvoiceRepository invoices;
    private final PricingClient pricing;
    private static final Logger log = null;
}

@Repository
public interface InvoiceRepository extends JpaRepository<Invoice, Long> {}

@Entity
public class Invoice {}

@Configuration
public class AppConfig {
    @Bean
    public DataSource dataSource() { return null; }

    @Bean(name = "mapper")
    ObjectMapper objectMapper() { return null; }
}
`);
  const role = (r) => byRole(list, r).map((f) => f.symbolName);
  assert.deepEqual(role('service'), ['BillingService']);
  assert.deepEqual(role('repository').sort(), ['InvoiceRepository', 'InvoiceRepository']);
  assert.deepEqual(role('entity'), ['Invoice']);
  assert.deepEqual(role('configuration'), ['AppConfig']);
  assert.deepEqual(byRole(list, 'bean').map((f) => [f.symbolName, f.detail]), [['dataSource', 'DataSource'], ['objectMapper', 'ObjectMapper']]);
  const injected = byRole(list, 'injects').filter((f) => f.symbolName === 'BillingService').map((f) => f.detail).sort();
  assert.deepEqual(injected, ['InvoiceRepository', 'PricingClient']);
});

test('Java: ServiceLoader hint; commented-out annotations ignored', () => {
  const list = facts('src/Plugins.java', `
public class Plugins {
    // @Autowired private Ghost ghost;
    /* Class.forName("x") */
    void load() { ServiceLoader.load(Plugin.class); }
}
`);
  assert.deepEqual(details(list, 'dynamic'), ['ServiceLoader']);
  assert.deepEqual(byRole(list, 'injects'), []);
});

// --- Python ----------------------------------------------------------------

test('Python: Django urlpatterns and models', () => {
  const urls = facts('shop/urls.py', `
from django.urls import path, re_path, include
from . import views

urlpatterns = [
    path('orders/', views.OrderList.as_view(), name='orders'),
    re_path(r'^legacy/(?P<id>\\d+)/$', views.legacy),
    path('api/', include('shop.api.urls')),
]
`);
  const routes = parsed(urls, 'route');
  assert.deepEqual(routes[0], { method: 'ANY', path: 'orders/', handler: 'views.OrderList' });
  assert.equal(routes[1].handler, 'views.legacy');
  assert.deepEqual(routes[2], { method: 'ANY', path: 'api/', handler: 'shop.api.urls' });

  const models = facts('shop/models.py', `
from django.db import models

class Order(models.Model):
    total = models.DecimalField()

    class Meta:
        ordering = ['id']

class Helper:
    pass
`);
  assert.deepEqual(byRole(models, 'model').map((f) => [f.symbolName, f.framework]), [['Order', 'django']]);
});

test('Python: FastAPI/Flask routes, Depends injection, dynamic hints', () => {
  const list = facts('api/main.py', `
from fastapi import FastAPI, Depends
import importlib

app = FastAPI()

@app.get("/users/{uid}")
async def read_user(uid: int, db=Depends(get_db), user=Depends(auth.current_user)):
    """Example in docstring: @app.post("/ghost")"""
    return getattr(db, uid)

@router.post("/users", status_code=201)
def create_user():
    mod = importlib.import_module(name)
    eval(code); model.eval()
    return __import__(name)

@bp.route("/legacy", methods=["GET", "POST"])
def legacy(): exec(src)

@mock.patch("not.a.route")
def test_it(): pass
`);
  const routes = byRole(list, 'route').map((f) => ({ sym: f.symbolName, ...JSON.parse(f.detail) }));
  assert.deepEqual(routes, [
    { sym: 'read_user', method: 'GET', path: '/users/{uid}' },
    { sym: 'create_user', method: 'POST', path: '/users' },
    { sym: 'legacy', method: 'GET,POST', path: '/legacy' }
  ]);
  assert.deepEqual(details(list, 'injects').sort(), ['current_user', 'get_db']);
  assert.equal(byRole(list, 'injects')[0].symbolName, 'read_user');
  assert.deepEqual(details(list, 'dynamic').sort(), ['__import__', 'eval', 'exec', 'getattr', 'importlib.import_module']);
  assert.equal(byRole(list, 'dynamic').find((f) => f.detail === 'eval').symbolName, 'create_user');
  assert.equal(byRole(list, 'dynamic').filter((f) => f.detail === 'eval').length, 1, 'model.eval() is a method, not the builtin');
});

// --- JS / TS dynamic hints --------------------------------------------------

// The template literal with ${} is dynamic (file level); require(name) is dynamic inside load().
test('JS/TS dynamic hints: only non-literal require/import, eval, new Function, computed window/this', () => {
  const list = facts('src/loader.js', `
const a = require('./static');
const b = import('./static-too');
const c = require(\`./tpl/\${name}\`);
function load(name) {
  const m = require(name);
  const lazy = import(base + name);
  eval('1+1');
  const f = new Function('a', 'return a');
  return window[name] || this[key] || window['literal'] || this[0];
}
`);
  assert.deepEqual(details(list, 'dynamic').sort(), [
    'eval', 'import(variable)', 'new Function', 'require(variable)', 'require(variable)', 'this[variable]', 'window[variable]'
  ]);
  assert.equal(byRole(list, 'dynamic').find((f) => f.detail === 'eval').symbolName, 'load');
  assert.equal(byRole(list, 'dynamic').find((f) => f.detail === 'require(variable)' && f.symbolName === 'load').line, 6);
  assert.deepEqual(facts('src/clean.ts', "const x = require('a'); const y = obj.eval(1);"), []);
});

// --- PHP -------------------------------------------------------------------

test('PHP Laravel routes, constructor injection with use-aliases, Symfony #[Route]', () => {
  const routes = facts('routes/web.php', `<?php
use App\\Http\\Controllers\\UserController;

Route::get('/users', [UserController::class, 'index']);
Route::post('/users', 'UserController@store');
Route::match(['get', 'post'], '/form', [FormController::class, 'handle']);
Route::apiResource('photos', PhotoController::class);
`);
  assert.deepEqual(parsed(routes, 'route'), [
    { method: 'GET', path: '/users', controller: 'UserController', action: 'index' },
    { method: 'POST', path: '/users', controller: 'UserController', action: 'store' },
    { method: 'GET,POST', path: '/form', controller: 'FormController', action: 'handle' },
    { method: 'RESOURCE', path: 'photos', controller: 'PhotoController' }
  ]);

  const ctl = facts('app/Http/Controllers/UserController.php', `<?php
namespace App\\Http\\Controllers;

use App\\Services\\Mailer as Postman;
use App\\Repositories\\UserRepository;

class UserController extends Controller
{
    public function __construct(private UserRepository $users, protected Postman $mail, int $limit = 5, ?Cache $cache = null) {}

    public function boot() { $svc = app(BillingService::class); return call_user_func($cb); }
}
`);
  assert.deepEqual(details(ctl, 'injects').sort(), ['BillingService', 'Cache', 'Mailer', 'UserRepository']);
  assert.equal(byRole(ctl, 'injects')[0].symbolName, 'UserController');
  assert.deepEqual(details(ctl, 'dynamic'), ['call_user_func']);

  const sf = facts('src/Controller/BlogController.php', `<?php
#[Route('/blog', name: 'blog')]
class BlogController
{
    #[Route('/{slug}', name: 'post', methods: ['GET', 'HEAD'])]
    public function show(string $slug) {}
}
`);
  assert.deepEqual(byRole(sf, 'route').map((f) => [f.symbolName, JSON.parse(f.detail)]), [
    ['BlogController', { method: 'ANY', path: '/blog' }],
    ['show', { method: 'GET,HEAD', path: '/blog/{slug}' }]
  ]);
});

// --- never throws ----------------------------------------------------------

test('extractFrameworkFacts never throws and bounds its work', () => {
  const garbage = Array.from({ length: 5000 }, (_, i) => String.fromCharCode((i * 7919) % 256)).join('');
  const nasty = [
    '', ' ', garbage, '@Component({', '@Autowired', 'Route::get(', '#[Route(', '@app.get(', 'constructor(', '{{{{{{', '<<<<>>>>',
    "'unterminated", '`unterminated ${', '(((((((((', '@Inject(', 'class ', 'path: \'x\'', 'x'.repeat(100000), '{ path: ',
    '@Pipe({ name: ', 'inject<', 'Depends(', 'url(', 'path(\'x\', include('
  ];
  const exts = ['.ts', '.tsx', '.js', '.html', '.java', '.py', '.php', '.txt', '', undefined];
  for (const src of nasty) {
    for (const ext of exts) assert.ok(Array.isArray(extractFrameworkFacts('f' + (ext || ''), ext, src)));
  }
  for (const bad of [null, undefined, 42, {}, []]) assert.deepEqual(extractFrameworkFacts('a.ts', '.ts', bad), []);

  const big = 'x'.repeat(1024 * 1024);
  for (const ext of exts) assert.deepEqual(extractFrameworkFacts('big', ext, big), []);

  // Just over the cap is skipped outright, even if it is full of facts.
  const over = '@Autowired private Foo foo;\n'.repeat(Math.ceil(MAX_SOURCE_CHARS / 28) + 1);
  assert.deepEqual(extractFrameworkFacts('A.java', '.java', over), []);

  // Just under the cap is processed, and the fact count stays bounded.
  const dense = '<app-a></app-a>'.repeat(20000).slice(0, MAX_SOURCE_CHARS - 1);
  assert.ok(extractFrameworkFacts('a.html', '.html', dense).length <= 1000);
  const many = Array.from({ length: 5000 }, (_, i) => `<app-x${i}></app-x${i}>`).join('\n').slice(0, MAX_SOURCE_CHARS - 1);
  assert.equal(extractFrameworkFacts('b.html', '.html', many).length, 1000);
});

// --- store round trip ------------------------------------------------------

test('graphStore: insertFacts -> findFacts / getFactsForFile / countFactsByRole, delete cascades', () =>
  withStore((store) => {
    const { fileId } = store.upsertFile('src/a.ts', 'h', 1, '.ts', parsedSymbols([{ name: 'A', kind: 'class' }]));
    store.insertFacts(fileId, [
      { symbolName: 'A', framework: 'angular', role: 'injects', detail: 'BService', line: 3 },
      { symbolName: 'A', framework: 'angular', role: 'component', detail: { selector: 'app-a' }, line: 1 },
      { symbolName: null, framework: 'angular', role: 'route', detail: null, line: 9 }
    ]);
    const { fileId: other } = store.upsertFile('src/b.ts', 'h2', 1, '.ts', parsedSymbols([{ name: 'B', kind: 'class' }]));
    store.insertFacts(other, [{ symbolName: 'B', framework: 'angular', role: 'injects', detail: 'BService', line: 2 }]);

    assert.deepEqual(store.findFacts({ role: 'injects', detail: 'BService' }).map((f) => f.path), ['src/a.ts', 'src/b.ts']);
    assert.deepEqual(store.findFacts({ framework: 'angular', role: 'component' }).map((f) => f.detail), ['{"selector":"app-a"}']);
    assert.deepEqual(store.getFactsForFile('src/a.ts').map((f) => [f.role, f.line, f.symbol_name]), [
      ['component', 1, 'A'], ['injects', 3, 'A'], ['route', 9, null]
    ]);
    assert.deepEqual(store.countFactsByRole(), { component: 1, injects: 2, route: 1 });

    // upsertFile of a changed file drops its old facts (same order buildBrain uses).
    const re = store.upsertFile('src/a.ts', 'h3', 2, '.ts', parsedSymbols([{ name: 'A', kind: 'class' }]));
    assert.deepEqual(store.getFactsForFile('src/a.ts'), []);
    store.insertFacts(re.fileId, [{ symbolName: 'A', framework: 'angular', role: 'injects', detail: 'CService', line: 1 }]);
    assert.equal(store.findFacts({ role: 'injects' }).length, 2);

    store.deleteFile('src/b.ts');
    assert.deepEqual(store.findFacts({ role: 'injects' }).map((f) => f.detail), ['CService']);
    store.clearAll();
    assert.deepEqual(store.countFactsByRole(), {});
  }));

test('graphStore: an existing brain without framework_facts upgrades on open', () => {
  const { dir, cleanup } = tempDir();
  try {
    const first = new GraphStore(dir);
    first.db.exec('DROP INDEX idx_framework_facts_role_detail; DROP INDEX idx_framework_facts_file; DROP TABLE framework_facts');
    first.close();
    const second = new GraphStore(dir);
    assert.deepEqual(second.countFactsByRole(), {});
    second.close();
  } finally {
    cleanup();
  }
});

test('graphStore: credential-shaped detail is redacted (I-8)', () =>
  withStore((store) => {
    const { fileId } = store.upsertFile('a.py', 'h', 1, '.py', parsedSymbols([{ name: 'f' }]));
    store.insertFacts(fileId, [{ symbolName: 'f', framework: 'flask', role: 'route', detail: 'key AKIAABCDEFGHIJKLMNOP', line: 1 }]);
    assert.doesNotMatch(store.getFactsForFile('a.py')[0].detail, /AKIA/);
  }));

// --- impact ----------------------------------------------------------------

function indexFile(store, relPath, source, symbols) {
  const ext = relPath.slice(relPath.lastIndexOf('.'));
  const { fileId } = store.upsertFile(relPath, relPath, 1, ext, parsedSymbols(symbols));
  store.insertFacts(fileId, extractFrameworkFacts(relPath, ext, source));
  return fileId;
}

const symbolOf = (store, name) => {
  const s = store.db.prepare('SELECT s.id, s.name, f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.name = ?').get(name);
  return { id: s.id, name: s.name, path: s.path };
};

test('frameworkCouplings: Angular component <-> template, injection and routes', () =>
  withStore((store) => {
    indexFile(store, 'src/app/user-card/user-card.component.ts', USER_CARD_TS, [{ name: 'UserCardComponent', kind: 'class' }]);
    indexFile(store, 'src/app/user-card/user-card.component.html', '<h1>{{ user.name }}</h1>', [{ name: 'user-card.component.html', kind: 'file' }]);
    indexFile(store, 'src/app/app.component.ts', `
@Component({ selector: 'app-root', templateUrl: './app.component.html' })
export class AppComponent {}
`, [{ name: 'AppComponent', kind: 'class' }]);
    indexFile(store, 'src/app/app.component.html', '<app-user-card [user]="u"></app-user-card>\n', [{ name: 'app.component.html', kind: 'file' }]);
    // Sibling-name ownership: no templateUrl, template lives next to the class.
    indexFile(store, 'src/app/list/list.component.ts', `
@Component({ selector: 'app-list' })
export class ListComponent {}
`, [{ name: 'ListComponent', kind: 'class' }]);
    indexFile(store, 'src/app/list/list.component.html', '<div><app-user-card></app-user-card></div>', [{ name: 'list.component.html', kind: 'file' }]);
    indexFile(store, 'src/app/routes.ts', "export const routes = [{ path: 'u', component: UserCardComponent }];", [{ name: 'routes', kind: 'function' }]);
    indexFile(store, 'src/app/user.service.ts', `
@Injectable({ providedIn: 'root' })
export class UserService {}
`, [{ name: 'UserService', kind: 'class' }]);

    const card = frameworkCouplings(store, symbolOf(store, 'UserCardComponent'));
    const pick = (rel) => card.filter((c) => c.relation === rel).map((c) => `${c.name}@${c.path}`).sort();
    assert.deepEqual(pick('template-uses'), [
      'AppComponent@src/app/app.component.ts',
      'ListComponent@src/app/list/list.component.ts',
      'app.component.html@src/app/app.component.html',
      'list.component.html@src/app/list/list.component.html'
    ]);
    assert.deepEqual(pick('route'), ['routes.ts@src/app/routes.ts']);
    const appRow = card.find((c) => c.name === 'app.component.html');
    assert.equal(appRow.line, 1);
    assert.match(appRow.why, /<app-user-card>/);

    const svc = frameworkCouplings(store, symbolOf(store, 'UserService'));
    assert.deepEqual(svc.map((c) => [c.relation, c.name, c.path]), [
      ['injected-by', 'UserCardComponent', 'src/app/user-card/user-card.component.ts']
    ]);
  }));

test('frameworkCouplings: Spring service injected into a controller, controller routes', () =>
  withStore((store) => {
    indexFile(store, 'src/OrderController.java', ORDER_CONTROLLER_JAVA, [
      { name: 'OrderController', kind: 'class', body: ORDER_CONTROLLER_JAVA, startByte: 0, endByte: ORDER_CONTROLLER_JAVA.length },
      { name: 'get', kind: 'method', startByte: 10, endByte: 20 }
    ]);
    indexFile(store, 'src/OrderService.java', '@Service\npublic class OrderService {}\n', [{ name: 'OrderService', kind: 'class' }]);
    indexFile(store, 'src/Mailer.java', '@Service\npublic class Mailer {}\n', [{ name: 'Mailer', kind: 'class' }]);

    const svc = frameworkCouplings(store, symbolOf(store, 'OrderService'));
    assert.equal(svc.length, 1);
    assert.equal(svc[0].relation, 'injected-by');
    assert.equal(svc[0].name, 'OrderController');
    assert.equal(svc[0].path, 'src/OrderController.java');
    assert.equal(svc[0].line, 7);
    assert.match(svc[0].why, /injects OrderService/);

    assert.deepEqual(frameworkCouplings(store, symbolOf(store, 'Mailer')), []);

    // The controller's own routes surface through its members.
    const ctl = frameworkCouplings(store, symbolOf(store, 'OrderController'));
    assert.ok(ctl.some((c) => c.relation === 'route' && c.name === 'get' && /GET \/api\/orders\/\{id\}/.test(c.why)));
  }));

test('frameworkCouplings: @Bean return type is the injected type', () =>
  withStore((store) => {
    indexFile(store, 'src/AppConfig.java', '@Configuration\npublic class AppConfig {\n @Bean\n public DataSource dataSource() { return null; }\n}\n', [
      { name: 'AppConfig', kind: 'class' }, { name: 'dataSource', kind: 'method' }
    ]);
    indexFile(store, 'src/Repo.java', '@Repository\npublic class Repo { @Autowired DataSource ds; }\n', [{ name: 'Repo', kind: 'class' }]);
    const rows = frameworkCouplings(store, symbolOf(store, 'dataSource'));
    assert.deepEqual(rows.map((r) => [r.relation, r.name]), [['injected-by', 'Repo']]);
  }));

test('dynamicRiskFor: none / some / high', () =>
  withStore((store) => {
    indexFile(store, 'src/plain.ts', 'export function plain() { return 1; }', [{ name: 'plain' }]);
    assert.deepEqual(dynamicRiskFor(store, symbolOf(store, 'plain')), { level: 'none', reasons: [] });

    indexFile(store, 'src/dispatch.js', "function run(n) { return handlers[n](); }\nfunction go(n) { return eval(n); }\nconst target = 'pay_invoice';", [
      { name: 'go', body: "function go(n) { return eval(n); }" },
      { name: 'dispatch', body: "const table = { x: 'pay_invoice', y: \"other_thing\" };" }
    ]);
    indexFile(store, 'src/billing.js', 'function pay_invoice() {}\nfunction other() {}\nfunction unrelated_fn() {}', [
      { name: 'pay_invoice' }, { name: 'other' }, { name: 'unrelated_fn' }
    ]);

    const own = dynamicRiskFor(store, symbolOf(store, 'go'));
    assert.equal(own.level, 'high');
    assert.match(own.reasons[0], /own file src\/dispatch\.js.*eval/);

    const named = dynamicRiskFor(store, symbolOf(store, 'pay_invoice'));
    assert.equal(named.level, 'high');
    assert.match(named.reasons.join('\n'), /'pay_invoice' appears as a string literal in src\/dispatch\.js/);

    const some = dynamicRiskFor(store, symbolOf(store, 'unrelated_fn'));
    assert.equal(some.level, 'some');
    assert.match(some.reasons[0], /1 dynamic-dispatch hint\(s\) in 1 file\(s\)/);
    assert.equal(dynamicRiskFor(store, symbolOf(store, 'plain')).level, 'some');
  }));
