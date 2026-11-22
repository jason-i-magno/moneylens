// Browser side of the monthly review's local API (server/reviewApi.js): written summaries and notifications
import { localApiRequest } from './localApi';

const NO_SERVER = "Written summaries and notifications come from MoneyLens's local server; open the app through it to use them.";

export const reviewRequest = (action, body = {}) => localApiRequest(`/api/review/${action}`, body, NO_SERVER);
