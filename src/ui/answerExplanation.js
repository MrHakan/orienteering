import { buildAnswerExplanation, explanationComparisons, explanationReport } from '../engine/answerExplanation.js';

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

/** Added only after an answer; all dynamic text is inserted as text, never HTML. */
export function appendAnswerExplanation(container, quiz, chosenLabel, model) {
  const explanation = quiz.explanation || buildAnswerExplanation(quiz, model);
  const section = element('section', undefined, 'answer-explanation');
  section.setAttribute('aria-labelledby', 'answer-explanation-title');
  const title = element('h3', `Why ${quiz.correctLabel} is the answer`);
  title.id = 'answer-explanation-title';
  section.append(title, element('p', explanation.correct.summary));
  const clues = element('ul', undefined, 'answer-evidence');
  for (const clue of explanation.correct.evidence) clues.append(element('li', clue.text));
  section.append(clues);
  if (explanation.caution) section.append(element('p', explanation.caution, 'answer-caution'));

  const comparisons = explanationComparisons(quiz, chosenLabel, explanation);
  if (comparisons.length) {
    section.append(element('h3', quiz.grid ? 'Similar cells — why not these?' : 'Why not the other answers?'));
    for (const comparison of comparisons) {
      const article = element('article', undefined, 'answer-alternative');
      article.dataset.label = comparison.label;
      article.dataset.chosen = String(comparison.label === chosenLabel);
      article.append(element('h4', `${comparison.label}${comparison.label === chosenLabel ? ' · your answer' : ''}`));
      if (comparison.plausibility) article.append(element('p', comparison.plausibility));
      for (const reason of comparison.reasons) article.append(element('p', reason.text));
      if (comparison.scope === 'qualified-point') article.append(element('p',
        'This comparison tests a possible person position inside the cell, rather than assuming he stands at its centre.', 'note'));
      section.append(article);
    }
  }

  const download = element('button', 'Download explanation JSON', 'btn ghost small');
  download.type = 'button'; download.id = 'download-explanation';
  download.addEventListener('click', () => {
    const report = explanationReport({ ...quiz, explanation }, chosenLabel);
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url;
    link.download = `explanation-${quiz.seed}-${quiz.mode}-${quiz.difficulty}-v${quiz.variant || 0}.json`.replace(/[^a-z0-9._-]+/gi, '-');
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  section.append(download);
  container.querySelector('.verdict').after(section);
}
