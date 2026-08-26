import { repositories } from "@/config/repositories";

function publicationLabel(mode: "required" | "slack-only"): string {
  return mode === "required" ? "GitHub + Slack" : "Slack only";
}

function ArrowIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path d="M3 8h9M8.5 3.5 13 8l-4.5 4.5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path d="m3 8.5 3 3 7-7" />
    </svg>
  );
}

const platformSteps = [
  {
    number: "01",
    eyebrow: "Vercel Cron",
    title: "Schedule",
    description: "Repository policies become authenticated UTC schedules at deploy time.",
  },
  {
    number: "02",
    eyebrow: "Workflow",
    title: "Orchestrate",
    description: "Durable steps coordinate leases, retries, state, and terminal delivery.",
  },
  {
    number: "03",
    eyebrow: "Sandbox + AI Gateway",
    title: "Analyze",
    description: "Untrusted source is reviewed inside an isolated, persistent microVM.",
  },
  {
    number: "04",
    eyebrow: "Connect",
    title: "Publish",
    description: "Short-lived credentials deliver findings to GitHub and every outcome to Slack.",
  },
] as const;

const outcomes = [
  ["GitHub issues", "Source-backed findings stay beside the code and update deterministically by commit."],
  ["Slack notifications", "Every terminal outcome reaches the channel your security team already watches."],
  ["Vercel observability", "Inspect Workflow retries, failures, and Sandbox lifecycle events in one place."],
] as const;

export default function Home() {
  const enabledRepositories = repositories.filter((repository) => repository.enabled);
  const issueRepositories = enabledRepositories.filter(
    (repository) => repository.issuePublication === "required",
  );
  const isConfigured = enabledRepositories.length > 0;

  return (
    <main>
      <nav className="nav shell" aria-label="Primary navigation">
        <a className="wordmark" href="#top" aria-label="deepsec Runner home">
          <span className="vercelMark" aria-hidden="true" />
          <span>deepsec</span>
          <span className="wordmarkDivider" aria-hidden="true" />
          <span className="wordmarkProduct">Runner</span>
        </a>

        <div className="navLinks">
          <a href="#platform">Platform</a>
          <a href="#repositories">Repositories</a>
          <a href="#delivery">Delivery</a>
        </div>

        <div className={`configBadge ${isConfigured ? "isReady" : "isPending"}`}>
          <span className="statusDot" aria-hidden="true" />
          {isConfigured ? `${enabledRepositories.length} enabled` : "Setup required"}
        </div>
      </nav>

      <section className="hero shell" id="top">
        <div className="heroGrid" aria-hidden="true" />
        <div className="heroContent">
          <div className="eyebrowPill">
            <span className="eyebrowIcon"><CheckIcon /></span>
            Security reviews on every schedule
          </div>
          <h1>
            Find risk before
            <span> it finds production.</span>
          </h1>
          <p>
            Run durable, isolated deepsec reviews across your GitHub repositories—then
            deliver clear findings where your team already works.
          </p>
          <div className="heroActions">
            <a className="button buttonPrimary" href="#repositories">
              View policies <ArrowIcon />
            </a>
            <a className="button buttonSecondary" href="#platform">
              Explore architecture
            </a>
          </div>
          <div className="trustRow" aria-label="Platform capabilities">
            <span><CheckIcon /> Isolated execution</span>
            <span><CheckIcon /> Durable workflows</span>
            <span><CheckIcon /> Least-privilege access</span>
          </div>
        </div>
      </section>

      <section className="metrics shell" aria-label="Configuration summary">
        <article>
          <strong>{enabledRepositories.length.toString().padStart(2, "0")}</strong>
          <div>
            <span>Enabled repositories</span>
            <small>{repositories.length} policies registered</small>
          </div>
        </article>
        <article>
          <strong>{issueRepositories.length.toString().padStart(2, "0")}</strong>
          <div>
            <span>Issue publishers</span>
            <small>GitHub-backed delivery</small>
          </div>
        </article>
        <article>
          <strong>UTC</strong>
          <div>
            <span>Schedule timezone</span>
            <small>Derived at deployment</small>
          </div>
        </article>
        <article>
          <strong>REQ</strong>
          <div>
            <span>Slack delivery</span>
            <small>Verified during setup</small>
          </div>
        </article>
      </section>

      <section className="platformSection shell section" id="platform">
        <div className="sectionIntro">
          <span className="sectionKicker">The platform</span>
          <h2>Security infrastructure,<br />without the infrastructure tax.</h2>
          <p>
            deepsec Runner composes native Vercel primitives into one secure control plane.
            Each layer has a narrow job and a clear trust boundary.
          </p>
        </div>

        <div className="platformFlow">
          {platformSteps.map((step) => (
            <article className="flowCard" key={step.number}>
              <div className="flowTopline">
                <span>{step.number}</span>
                <span className="flowNode" aria-hidden="true" />
              </div>
              <span className="flowEyebrow">{step.eyebrow}</span>
              <h3>{step.title}</h3>
              <p>{step.description}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="repositorySection section" id="repositories">
        <div className="shell">
          <div className="sectionIntro splitIntro">
            <div>
              <span className="sectionKicker">Repository policies</span>
              <h2>One registry.<br />Every review.</h2>
            </div>
            <p>
              Policy is code: each repository declares its schedule, execution profile,
              analysis focus, and publication behavior in one reviewable place.
            </p>
          </div>

          <div className="repositoryList">
            {repositories.map((repository, index) => (
              <article className="repositoryRow" key={repository.id}>
                <div className="repoIdentity">
                  <span className="repoNumber">{String(index + 1).padStart(2, "0")}</span>
                  <div>
                    <h3>{repository.repository}</h3>
                    <span className={`repoStatus ${repository.enabled ? "enabled" : "disabled"}`}>
                      <i aria-hidden="true" />
                      {repository.enabled ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                </div>

                <dl className="repoDetails">
                  <div>
                    <dt>Branch</dt>
                    <dd><code>{repository.defaultBranch}</code></dd>
                  </div>
                  <div>
                    <dt>Schedule</dt>
                    <dd><code>{repository.frequency}</code></dd>
                  </div>
                  <div>
                    <dt>Model</dt>
                    <dd>{repository.model} / {repository.thinkingLevel}</dd>
                  </div>
                  <div>
                    <dt>Delivery</dt>
                    <dd>{publicationLabel(repository.issuePublication)}</dd>
                  </div>
                </dl>

                <div className="repoRuntime">
                  <span>{repository.sandbox.vcpus} vCPU</span>
                  <span>{repository.priorityPaths.length || "Auto"} priority paths</span>
                  <span>{repository.cloneAccess === "github-app" ? "GitHub App" : "Public clone"}</span>
                </div>
              </article>
            ))}
          </div>

          <p className="configurationNote">
            <span aria-hidden="true">i</span>
            This is a static configuration summary, not live run telemetry.
          </p>
        </div>
      </section>

      <section className="deliverySection shell section" id="delivery">
        <div className="deliveryHeading">
          <span className="sectionKicker">Terminal delivery</span>
          <h2>Review results<br />where work happens.</h2>
        </div>
        <div className="outcomeGrid">
          {outcomes.map(([title, description], index) => (
            <article key={title}>
              <div className="outcomeIcon" aria-hidden="true">
                {index === 0 ? "GH" : index === 1 ? "SL" : "VC"}
              </div>
              <h3>{title}</h3>
              <p>{description}</p>
              <span className="outcomeIndex">0{index + 1}</span>
            </article>
          ))}
        </div>
      </section>

      <section className="ctaSection shell">
        <div className="ctaGlow" aria-hidden="true" />
        <span className="vercelMark ctaMark" aria-hidden="true" />
        <h2>Ready for your first secure scan.</h2>
        <p>Configure a repository policy, verify delivery, and deploy.</p>
        <a className="button buttonLight" href="#repositories">
          Review configuration <ArrowIcon />
        </a>
      </section>

      <footer className="footer shell">
        <a className="wordmark" href="#top" aria-label="Back to top">
          <span className="vercelMark" aria-hidden="true" />
          <span>deepsec Runner</span>
        </a>
        <p>Workflow · Sandbox · AI Gateway · Connect</p>
        <span>Built on Vercel</span>
      </footer>
    </main>
  );
}
