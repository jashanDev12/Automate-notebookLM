import { getInteractiveHtml, getArtifactState, exportArtifactToDocs } from './rpc';
import type { Artifact, AuthSession, Flashcard, MindMapNode, QuizQuestion } from './types';
import { createLogger } from './logger';

const log = createLogger('artifacts');

export function extractAppData(htmlContent: string): any {
  const match = /data-app-data="([^"]+)"/.exec(htmlContent);
  if (!match) {
    throw new Error('No data-app-data attribute found in HTML');
  }

  const encodedJson = match[1];
  // Decode HTML entities
  const decodedJson = encodedJson
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'");

  return JSON.parse(decodedJson);
}

function parseStateQuestions(rawQuestions: any[]): QuizQuestion[] {
  if (!Array.isArray(rawQuestions)) return [];
  
  return rawQuestions.map(qBlock => {
    // qBlock is [null, null, null, null, [[["question", [null, null, null, null, [[["type", ...], ["question", ...]]]]]]]]
    const contentBlock = qBlock?.[4]?.[0];
    const questionTuple = contentBlock?.find((t: any) => t?.[0] === 'question');
    const questionData = questionTuple?.[1]?.[4]?.[0];
    
    if (!questionData) return null;

    const typeTuple = questionData.find((t: any) => t?.[0] === 'type');
    const questionTextTuple = questionData.find((t: any) => t?.[0] === 'question');
    const optionsTuple = questionData.find((t: any) => t?.[0] === 'answerOptions');
    const hintTuple = questionData.find((t: any) => t?.[0] === 'hint');

    const questionText = questionTextTuple?.[1]?.[1];
    const rawOptions = optionsTuple?.[1]?.[4]?.[0];
    const hint = hintTuple?.[1]?.[1];

    if (!questionText || !Array.isArray(rawOptions)) return null;

    const answerOptions = rawOptions.map(optBlock => {
      // optBlock is [null, null, null, null, [[["text", ...], ["isCorrect", ...]]]]
      const optTuples = optBlock?.[4]?.[0];
      const textTuple = optTuples?.find((t: any) => t?.[0] === 'text');
      const isCorrectTuple = optTuples?.find((t: any) => t?.[0] === 'isCorrect');
      
      return {
        text: textTuple?.[1]?.[1] || '',
        isCorrect: isCorrectTuple?.[1]?.[3] || false
      };
    });

    const parsedQuestion: QuizQuestion = {
      question: questionText,
      answerOptions,
    };
    if (hint) parsedQuestion.hint = hint;

    return parsedQuestion;
  }).filter((q): q is QuizQuestion => q !== null);
}

export function formatQuizMarkdown(title: string, questions: QuizQuestion[]): string {
  let md = `# ${title}\n\n`;
  questions.forEach((q, i) => {
    md += `## Question ${i + 1}\n${q.question}\n\n`;
    q.answerOptions.forEach((opt) => {
      const marker = opt.isCorrect ? '[x]' : '[ ]';
      md += `- ${marker} ${opt.text}\n`;
    });
    if (q.hint) {
      md += `\n**Hint:** ${q.hint}\n`;
    }
    md += '\n';
  });
  return md;
}

export function formatFlashcardsMarkdown(title: string, cards: Flashcard[]): string {
  let md = `# ${title}\n\n`;
  cards.forEach((card, i) => {
    md += `## Card ${i + 1}\n\n**Q:** ${card.front}\n\n**A:** ${card.back}\n\n---\n\n`;
  });
  return md;
}

export async function exportArtifact(
  session: AuthSession,
  notebookId: string,
  artifact: Artifact,
  format: 'json' | 'markdown' | 'html' | 'pptx',
): Promise<{ content?: string; filename?: string; mimeType?: string; url?: string }> {
  log.info('Exporting artifact', { id: artifact.id, type: artifact.type, format });

  if (artifact.type === 'slide_deck' && format === 'pptx') {
    // 1. Trigger export to Google Slides
    const driveUrl = await exportArtifactToDocs(session, notebookId, artifact.id);
    
    // 2. Extract Document ID
    const match = /\/d\/([a-zA-Z0-9-_]+)/.exec(driveUrl);
    if (!match) {
      throw new Error('Failed to parse Document ID from Google Drive URL');
    }
    const docId = match[1];

    // 3. Construct native PPTX download link
    const downloadUrl = `https://docs.google.com/presentation/d/${docId}/export/pptx`;
    
    return {
      url: downloadUrl,
    };
  }

  if (artifact.type === 'mind_map') {
    const rawResult = await getInteractiveHtml(session, notebookId, artifact.id);
    // Mind Map tree is at [0][9][3]
    const tree = (rawResult as any)?.raw?.[0]?.[9]?.[3] || (rawResult as any)?.html?.[0]?.[9]?.[3] || (rawResult as any)?.[0]?.[9]?.[3];
    if (!tree) {
      throw new Error('Mind map data not yet ready or missing in response');
    }
    return {
      content: JSON.stringify(tree, null, 2),
      filename: `${artifact.title.replace(/\s+/g, '_')}.json`,
      mimeType: 'application/json',
    };
  }

  // Quizzes and Flashcards: Try ulBSjf first for structured data
  if (artifact.type === 'quiz' || artifact.type === 'flashcards') {
    try {
      const state = await getArtifactState(session, notebookId, artifact.id);
      
      // state follows the pattern: [[null, null, [[[["userAnswers", ...], ["latestCompletion", ...]]]]]]
      // The list of tuples is usually at state[0][2][0]
      const tuples = state?.[0]?.[2]?.[0];
      if (Array.isArray(tuples)) {
        const latestCompletionTuple = tuples.find((t: any) => t?.[0] === 'latestCompletion');
        const latestCompletion = latestCompletionTuple?.[1]?.[4]?.[0];
        const questionsTuple = latestCompletion?.find((t: any) => t?.[0] === 'questions');
        const questionsBlock = questionsTuple?.[1]?.[4]?.[0];

        if (questionsBlock) {
          const questions = parseStateQuestions(questionsBlock);
          if (questions.length > 0) {
            log.info('Exporting quiz from structured state', { count: questions.length });
            if (format === 'markdown') {
              return {
                content: formatQuizMarkdown(artifact.title, questions),
                filename: `${artifact.title.replace(/\s+/g, '_')}.md`,
                mimeType: 'text/markdown',
              };
            }
            if (format === 'json') {
              return {
                content: JSON.stringify({ title: artifact.title, questions }, null, 2),
                filename: `${artifact.title.replace(/\s+/g, '_')}.json`,
                mimeType: 'application/json',
              };
            }
          }
        }
      }
    } catch (err) {
      log.warn('Failed to export from structured state, falling back to HTML', err);
    }
  }

  // Fallback to HTML-based extraction
  const rawResult = await getInteractiveHtml(session, notebookId, artifact.id);
  const htmlContent = rawResult?.[0]?.[9]?.[0];
  if (typeof htmlContent !== 'string') {
    throw new Error('Failed to fetch artifact content');
  }

  if (format === 'html') {
    return {
      content: htmlContent,
      filename: `${artifact.title.replace(/\s+/g, '_')}.html`,
      mimeType: 'text/html',
    };
  }

  const appData = extractAppData(htmlContent);

  if (artifact.type === 'quiz') {
    const questions: QuizQuestion[] = appData.quiz || [];
    if (format === 'markdown') {
      return {
        content: formatQuizMarkdown(artifact.title, questions),
        filename: `${artifact.title.replace(/\s+/g, '_')}.md`,
        mimeType: 'text/markdown',
      };
    }
    return {
      content: JSON.stringify({ title: artifact.title, questions }, null, 2),
      filename: `${artifact.title.replace(/\s+/g, '_')}.json`,
      mimeType: 'application/json',
    };
  }

  if (artifact.type === 'flashcards') {
    const rawCards = appData.flashcards || [];
    const cards: Flashcard[] = rawCards.map((c: any) => ({
      front: c.f || '',
      back: c.b || '',
    }));
    if (format === 'markdown') {
      return {
        content: formatFlashcardsMarkdown(artifact.title, cards),
        filename: `${artifact.title.replace(/\s+/g, '_')}.md`,
        mimeType: 'text/markdown',
      };
    }
    return {
      content: JSON.stringify({ title: artifact.title, cards }, null, 2),
      filename: `${artifact.title.replace(/\s+/g, '_')}.json`,
      mimeType: 'application/json',
    };
  }

  throw new Error(`Export not supported for artifact type: ${artifact.type}`);
}
