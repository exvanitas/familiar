/* The Settings window, a placeholder until keys and addresses exist. Everything it draws is text. */
import { createShell } from '../shell.ts';

const shell = createShell();
const p = document.createElement('p');
p.textContent = 'Settings arrive in a later step.';
document.body.append(p);
void shell.log('settings up');
