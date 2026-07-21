const prisma = require('./src/lib/prisma');
const repo = require('./src/repositories/delivery.repository');

(async () => {
  const [a, b] = await Promise.all([
    repo.claimDeliveries(2),
    repo.claimDeliveries(2),
  ]);

  console.log('A:', a.map(r => r.id));
  console.log('B:', b.map(r => r.id));

  const overlap = a.filter(x => b.some(y => y.id === x.id));
  console.log('overlap:', overlap.length, overlap.length === 0 ? '(correct)' : '(BUG)');

  await prisma.$disconnect();
})();
