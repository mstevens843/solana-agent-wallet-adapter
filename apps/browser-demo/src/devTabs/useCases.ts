import { t } from '../demo-i18n/uiLang.js';

interface DevTabUseCase {
  title: string;
  body: string;
}

interface DevTabUseCaseDisclosure {
  id: string;
  summary: string;
  useCases: readonly DevTabUseCase[];
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;'
    : c === '<' ? '&lt;'
    : c === '>' ? '&gt;'
    : c === '"' ? '&quot;'
    : '&#39;',
  );
}

export function renderUseCaseDisclosure(config: DevTabUseCaseDisclosure): string {
  return `
    <details class="dev-tab-use-cases" data-dev-tab-use-cases="${escapeHtml(config.id)}">
      <summary>
        <span class="dev-tab-use-case-summary-copy">
          <strong>${escapeHtml(t('Use cases'))}</strong>
          <em>${escapeHtml(config.summary)}</em>
        </span>
      </summary>
      <div class="dev-tab-use-case-body">
        <div class="dev-tab-use-case-grid">
          ${config.useCases.map((useCase) => `
            <article>
              <h3>${escapeHtml(useCase.title)}</h3>
              <p>${escapeHtml(useCase.body)}</p>
            </article>
          `).join('')}
        </div>
      </div>
    </details>
  `;
}
