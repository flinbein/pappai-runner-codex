import { fileURLToPath } from 'node:url';

export const profileCli = {
  authorize: {
    description: 'Connect this PROFILE to ChatGPT using a device code.',
    doc: 'Open the verification URL in your browser and enter the code shown in this terminal. After sign-in, this command calls setup and status on the selected PROFILE as the current USER. The USER needs network access and permission for both methods.',
    version: '1',
    schema: {input:{type:'object', properties:{}, additionalProperties:false}},
  },
};

export async function prepareProfileCli(data, installation, runnerName) {
  if (data?.feature !== 'authorize' || typeof data.node !== 'string' || !data.node ||
      !data.input || typeof data.input !== 'object' || Array.isArray(data.input) ||
      Object.keys(data.input).length || Object.keys(data).some(key => !['feature','node','input'].includes(key))) {
    throw Error('Invalid PROFILE authorization command');
  }
  return {
    files:[fileURLToPath(new URL('./authorize.mjs',import.meta.url)), await installation.executable()],
    argv:['/usr/local/bin/node','/run/pappai/cli/0','/run/pappai/cli/1',data.node,runnerName],
  };
}
