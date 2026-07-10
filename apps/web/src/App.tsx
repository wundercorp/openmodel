import { useEffect, useState } from 'react';
import { Badge, Button, Card, CodeBlock } from './components/ui';
import { beginLogin, completeLogin, getSession, logout } from './lib/auth';

type Theme = 'dark' | 'light';
type Accent = 'orange' | 'green' | 'blue' | 'fuchsia';

const gateways = [
  ['Hugging Face', 'hf://', 'GGUF and registry artifacts'],
  ['Direct HTTPS', 'https://', 'Portable model artifacts'],
  ['Ollama', 'ollama://', 'Native Ollama registry models'],
  ['Your gateway', 'npm package', 'Versioned SDK and explicit registration']
];

export function App() {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('openmodel:theme') === 'light' ? 'light' : 'dark'));
  const [accent, setAccent] = useState<Accent>(() => (localStorage.getItem('openmodel:accent') as Accent) || 'orange');
  const [session, setSession] = useState(() => getSession());

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.accent = accent;
    localStorage.setItem('openmodel:theme', theme);
    localStorage.setItem('openmodel:accent', accent);
  }, [theme, accent]);

  useEffect(() => {
    completeLogin().then((completed) => completed && setSession(getSession())).catch(console.error);
  }, []);

  return <div className="page-shell">
    <header className="site-header">
      <a className="brand" href="#top"><span className="brand-mark">OM</span><span>openmodel.sh</span></a>
      <nav className="nav-links"><a href="#gateways">Gateways</a><a href="#api">API</a><a href="#deploy">Deploy</a><a href="https://github.com/wundercorp/openmodel">GitHub</a></nav>
      <div className="header-actions">
        <select aria-label="Accent color" value={accent} onChange={(event) => setAccent(event.target.value as Accent)}>
          <option value="orange">Orange</option><option value="green">Green</option><option value="blue">Blue</option><option value="fuchsia">Fuchsia</option>
        </select>
        <Button variant="ghost" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? 'Light' : 'OLED'}</Button>
        {session ? <Button variant="outline" onClick={logout}>Sign out</Button> : <Button onClick={beginLogin}>Sign in</Button>}
      </div>
    </header>

    <main id="top">
      <section className="hero section">
        <div className="hero-copy">
          <Badge>Gateway-first local inference</Badge>
          <h1>One CLI for models from everywhere.</h1>
          <p className="lead">Download portable artifacts, use native registries, run models through llama.cpp or Ollama, and expose one interoperable local API.</p>
          <div className="hero-actions"><Button onClick={() => navigator.clipboard.writeText('npm install -g @wundercorp/openmodel')}>Copy install command</Button><Button variant="outline" onClick={() => document.getElementById('gateways')?.scrollIntoView({ behavior: 'smooth' })}>Explore gateways</Button></div>
          <div className="trust-row"><span>Apache-2.0</span><span>Explicit plugins</span><span>OIDC ready</span><span>OpenAI + Ollama APIs</span></div>
        </div>
        <Card className="terminal-card">
          <div className="terminal-title"><span></span><span></span><span></span><strong>om</strong></div>
          <CodeBlock>{`$ npm i -g @wundercorp/openmodel
$ om pull hf://owner/repo/model.gguf --alias local
Downloading model.gguf: 812.4 MiB
Installed owner-repo-model-gguf as local.

$ om serve local --port 11435
OpenModel local API listening on http://127.0.0.1:11435`}</CodeBlock>
        </Card>
      </section>

      <section className="section stats-grid">
        <Card><strong>3</strong><span>built-in gateways</span></Card><Card><strong>2</strong><span>runtime adapters</span></Card><Card><strong>2</strong><span>compatible API shapes</span></Card><Card><strong>1</strong><span>stable gateway contract</span></Card>
      </section>

      <section id="gateways" className="section">
        <div className="section-heading"><Badge>Interoperability</Badge><h2>Gateways are plugins, not patches.</h2><p>Contributors add providers through a small public SDK. Core commands remain provider-neutral and runtime-neutral.</p></div>
        <div className="gateway-grid">{gateways.map(([name, scheme, description]) => <Card key={name}><div className="gateway-icon">{name.slice(0, 2).toUpperCase()}</div><h3>{name}</h3><code>{scheme}</code><p>{description}</p></Card>)}</div>
      </section>

      <section id="api" className="section split-section">
        <div><Badge>Local API</Badge><h2>Drop into existing tooling.</h2><p>Serve installed models through OpenAI-compatible chat completions or Ollama-compatible generation endpoints.</p><ul><li>GET /v1/models</li><li>POST /v1/chat/completions</li><li>GET /api/tags</li><li>POST /api/generate</li></ul></div>
        <Card><CodeBlock>{`curl http://127.0.0.1:11435/v1/chat/completions \\
  -H 'content-type: application/json' \\
  -d '{
    "model": "local",
    "messages": [{"role":"user","content":"Hello"}]
  }'`}</CodeBlock></Card>
      </section>

      <section id="deploy" className="section">
        <div className="section-heading"><Badge>Separate deployment</Badge><h2>Local runtime, website, and cloud layer stay independent.</h2></div>
        <div className="deploy-grid"><Card><h3>CLI</h3><p>Published to npm with provenance. No website bundle or deployment state enters the package.</p></Card><Card><h3>Website</h3><p>Static Vite build deployable through Docker, Kubernetes, or Cloudflare Pages.</p></Card><Card><h3>Cloud API</h3><p>Cloudflare Worker validates OIDC access tokens from auth.wundercorp.co.</p></Card></div>
      </section>
    </main>

    <footer><span>openmodel.sh</span><span>Built for local-first, gateway-friendly inference.</span></footer>
  </div>;
}
