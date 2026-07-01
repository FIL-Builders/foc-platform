import Link from 'next/link';

const steps = [
  ['Request', 'Create an idempotent platform upload request.'],
  ['Upload', 'Submit bytes through the platform upload endpoint.'],
  ['Status', 'Poll registry-backed upload state.'],
  ['Usage', 'Read account usage from the contract model.']
];

export default function HomePage() {
  return (
    <main className="pageStack">
      <section className="heroPanel">
        <div className="heroSplit">
          <div>
            <div className="eyebrow">/tokenhost/foc-platform</div>
            <h1 className="displayTitle">
              FOC Platform
              <br />
              <span>generated wrapper</span>
            </h1>
            <p className="lead">
              Token Host provides the generated demo shell, upload scaffold, manifest metadata, and sponsored transaction UX while the FOC registry and API keep lifecycle authority.
            </p>
            <div className="actionGroup">
              <Link className="btn primary" href="/UploadRequest/?mode=new">
                New upload
              </Link>
              <Link className="btn" href="/StorageObject/">
                Objects
              </Link>
            </div>
          </div>
          <div className="heroDataPanel">
            <div className="eyebrow">/wrapper/state</div>
            <div className="heroStatGrid">
              <div className="heroStat">
                <div className="heroStatValue">6.7</div>
                <div className="heroStatLabel">Protocol source</div>
              </div>
              <div className="heroStat">
                <div className="heroStatValue">2</div>
                <div className="heroStatLabel">Default copies</div>
              </div>
              <div className="heroStat">
                <div className="heroStatValue">API</div>
                <div className="heroStatLabel">Account mapping</div>
              </div>
              <div className="heroStat">
                <div className="heroStatValue">FOC</div>
                <div className="heroStatLabel">Upload target</div>
              </div>
            </div>
            <div className="heroMeta">
              <span className="badge">wrapper mode</span>
              <span className="badge">hand-written registry</span>
              <span className="badge">sponsored-ready</span>
              <span className="badge">calibration target</span>
            </div>
          </div>
        </div>
      </section>

      <section className="featureGrid">
        {steps.map(([title, body]) => (
          <div className="featureCard" key={title}>
            <div className="eyebrow">/{title.toLowerCase()}</div>
            <h2>{title}</h2>
            <p className="muted">{body}</p>
          </div>
        ))}
      </section>

      <section className="sectionHeading">
        <div className="sectionHeadingPrimary">
          <span className="eyebrow">/boundary</span>
          <h2>Generated UI, registry authority</h2>
        </div>
        <div className="sectionHeadingAside">
          <p className="muted">
            Generic Token Host CRUD is a scaffold here. Upload lifecycle, receipt finalization, relayer accountability, and usage accounting remain bound to FocPlatformRegistry and the platform API.
          </p>
        </div>
      </section>
    </main>
  );
}
