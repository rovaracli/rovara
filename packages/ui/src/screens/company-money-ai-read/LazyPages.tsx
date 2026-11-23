// The one lazy entry of the rebuilt company money / AI pages: each real route renders its screen inside ReadEntry (access check, action host, unconfirmed-outcome block).
import { ReadEntry } from './ReadEntry.js';
import { CostReportReadScreen } from './CostReportReadScreen.js';
import { FeatureDetailReadScreen } from './FeatureDetailReadScreen.js';
import { AiSourcesReadScreen } from './AiSourcesReadScreen.js';
import { SourceOrderReadScreen } from './SourceOrderReadScreen.js';
import { ProductAiKeysReadScreen } from './ProductAiKeysReadScreen.js';
export const CostReportPage = () => <ReadEntry><CostReportReadScreen /></ReadEntry>;
export const FeatureDetailPage = () => <ReadEntry><FeatureDetailReadScreen /></ReadEntry>;
export const AiSourcesPage = () => <ReadEntry><AiSourcesReadScreen /></ReadEntry>;
export const SourceOrderPage = () => <ReadEntry><SourceOrderReadScreen /></ReadEntry>;
export const ProductAiPage = () => <ReadEntry><ProductAiKeysReadScreen /></ReadEntry>;
