require('dotenv').config();
const { encrypt } = require('./src/services/crypto');

const hashKey = 'DMoHMf9gPuSNuPva';
const hashIV = 'vjiIBrJ5bx31HItE';

console.log('Encrypted HashKey:', encrypt(hashKey));
console.log('Encrypted HashIV:', encrypt(hashIV));
