const fs = require('fs');
const path = require('path');
const { Connection, PublicKey } = require('@solana/web3.js');
const { AccountLayout, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
require('dotenv').config();

(async () => {
  const rpc = process.env.RPC_URL || 'https://api.devnet.solana.com';
  const connection = new Connection(rpc, 'confirmed');
  const testAccounts = JSON.parse(fs.readFileSync(path.join(process.cwd(),'test-accounts.json'),'utf8'));
  for (const a of testAccounts) {
    try {
      const pub = new PublicKey(a.pubkey);
      const info = await connection.getAccountInfo(pub);
      if (!info) { console.log(a.pubkey, 'no account'); continue; }
      console.log('Pubkey:', a.pubkey);
      console.log('  Lamports:', info.lamports);
      console.log('  Owner:', info.owner.toBase58());
      console.log('  Data length:', info.data.length);
      if (info.owner.equals(TOKEN_PROGRAM_ID)) {
        const decoded = AccountLayout.decode(info.data);
        const closeAuthorityOption = decoded.closeAuthorityOption;
        const closeAuthority = closeAuthorityOption === 1 ? new PublicKey(decoded.closeAuthority).toBase58() : new PublicKey(decoded.owner).toBase58();
        console.log('  Token account - closeAuthorityOption:', closeAuthorityOption);
        console.log('  CloseAuthority:', closeAuthority);
        console.log('  Owner field:', new PublicKey(decoded.owner).toBase58());
      }
    } catch (err) { console.error('Error for', a.pubkey, err); }
  }
})();
