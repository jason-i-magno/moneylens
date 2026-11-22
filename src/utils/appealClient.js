// Browser side of the property tax protest's local API (server/appealApi.js): the letter written by Claude
import { localApiRequest } from './localApi';

const NO_SERVER = "Writing the letter with Claude needs MoneyLens's local server; the plain letter works without it.";

export const appealRequest = (action, body = {}) => localApiRequest(`/api/appeal/${action}`, body, NO_SERVER);
