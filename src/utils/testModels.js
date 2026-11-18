/**
 * testModels.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Run once to verify that all four Mongoose models can write to and read from
 * MongoDB Atlas.  Cleans up its own test documents after running.
 *
 * Usage (from the Backend/ folder):
 *   node src/utils/testModels.js
 */

import connectDB, { disconnectDB } from '../config/db.js';
import { User, Document, DocumentChunk, Conversation } from '../models/index.js';

// ── Helpers ───────────────────────────────────────────────────────────────────
const pass = (label) => console.log(`  ✅  ${label}`);
const fail = (label, err) => console.error(`  ❌  ${label}:`, err.message);

const section = (title) => {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(50));
};

// ── Test: User ────────────────────────────────────────────────────────────────
const testUser = async () => {
  section('1 / 4   User model');
  let userId;

  try {
    // Create
    const user = await User.create({
      name:     '__TestUser__',
      email:    '__test__@university.dev',
      password: 'TestPassword1!',
      role:     'student',
    });
    userId = user._id;
    pass(`Created user  id=${userId}`);

    // Read back (password excluded by default)
    const found = await User.findById(userId).select('+password');
    if (!found) throw new Error('User not found after create');
    pass(`Retrieved user  email=${found.email}  role=${found.role}`);

    // Password hashing
    const match = await found.comparePassword('TestPassword1!');
    if (!match) throw new Error('comparePassword returned false');
    pass('Password hashed & comparePassword works');

    // Duplicate email guard
    try {
      await User.create({
        name: '__DupUser__', email: '__test__@university.dev',
        password: 'AnotherPass1!',
      });
      fail('Duplicate email', new Error('Should have thrown but did not'));
    } catch {
      pass('Duplicate email correctly rejected');
    }

  } catch (err) {
    fail('User test', err);
  } finally {
    if (userId) {
      await User.findByIdAndDelete(userId);
      pass('Cleaned up test user');
    }
  }

  return userId; // may be undefined if create failed
};

// ── Test: Document ────────────────────────────────────────────────────────────
const testDocument = async (userId) => {
  section('2 / 4   Document model');
  let docId;

  try {
    const doc = await Document.create({
      title:            'Introduction to Computer Science',
      filename:         '__test_cs101.pdf',
      filePath:         'uploads/__test_cs101.pdf',
      category:         'lecture-notes',
      academicYear:     '2024/2025',
      uploadedBy:       userId ?? undefined,
      totalPages:       42,
      processingStatus: 'pending',
    });
    docId = doc._id;
    pass(`Created document  id=${docId}`);

    const found = await Document.findById(docId);
    if (!found) throw new Error('Document not found after create');
    pass(`Retrieved document  title="${found.title}"  category=${found.category}`);

    // Status update
    found.processingStatus = 'processing';
    found.processingLog.push({ stage: 'text-extraction', status: 'started', message: 'Beginning extraction' });
    await found.save();
    pass('Updated processingStatus and appended processingLog entry');

    // Virtual
    pass(`fileSizeFormatted virtual = "${found.fileSizeFormatted}"`);

    // Duplicate filename guard
    try {
      await Document.create({
        title: '__Dup__', filename: '__test_cs101.pdf',
        filePath: 'uploads/__test_cs101.pdf', uploadedBy: userId ?? undefined,
      });
      fail('Duplicate filename+uploadedBy', new Error('Should have thrown but did not'));
    } catch {
      pass('Duplicate filename+uploadedBy correctly rejected');
    }

  } catch (err) {
    fail('Document test', err);
  }

  return docId;
};

// ── Test: DocumentChunk ───────────────────────────────────────────────────────
const testDocumentChunk = async (docId) => {
  section('3 / 4   DocumentChunk model');
  const createdIds = [];

  try {
    if (!docId) throw new Error('No documentId available — skipping chunk test');

    const chunks = await DocumentChunk.insertMany([
      {
        documentId: docId,
        content:    'A computer is a machine that can be programmed to carry out sequences of arithmetic or logical operations automatically.',
        pageNumber:  1,
        chunkIndex:  0,
        metadata:   { tokenCount: 22, section: 'Introduction' },
      },
      {
        documentId: docId,
        content:    'Modern computers can perform billions of operations per second.',
        pageNumber:  1,
        chunkIndex:  1,
        metadata:   { tokenCount: 11 },
      },
    ]);
    chunks.forEach((c) => createdIds.push(c._id));
    pass(`Created ${chunks.length} chunks`);

    // Read all chunks for the document
    const fetched = await DocumentChunk.find({ documentId: docId });
    pass(`Retrieved ${fetched.length} chunks for documentId=${docId}`);

    // Embedding update
    const fake384Embedding = Array.from({ length: 384 }, () => Math.random() - 0.5);
    await DocumentChunk.findByIdAndUpdate(createdIds[0], {
      embedding:  fake384Embedding,
      isEmbedded: true,
    });
    pass('Updated chunk with 384-dim embedding vector');

    // Static helper
    const deleteResult = await DocumentChunk.deleteByDocument(docId);
    pass(`deleteByDocument cleaned up ${deleteResult.deletedCount} chunks`);
    createdIds.length = 0; // already deleted

    // Duplicate triplet guard
    await DocumentChunk.create({ documentId: docId, content: 'x', pageNumber: 1, chunkIndex: 0 });
    try {
      await DocumentChunk.create({ documentId: docId, content: 'y', pageNumber: 1, chunkIndex: 0 });
      fail('Duplicate triplet', new Error('Should have thrown but did not'));
    } catch {
      pass('Duplicate (documentId, pageNumber, chunkIndex) correctly rejected');
    }
    // Clean up the one we just made
    await DocumentChunk.deleteMany({ documentId: docId });

  } catch (err) {
    fail('DocumentChunk test', err);
    // best-effort cleanup
    if (createdIds.length) await DocumentChunk.deleteMany({ _id: { $in: createdIds } });
  }
};

// ── Test: Conversation ────────────────────────────────────────────────────────
const testConversation = async (userId) => {
  section('4 / 4   Conversation model');
  let convId;

  try {
    const conv = await Conversation.create({
      userId,
      title: 'New Conversation',
    });
    convId = conv._id;
    pass(`Created conversation  id=${convId}  sessionId=${conv.sessionId}`);

    // addMessage instance method
    await conv.addMessage({ role: 'user',      content: 'What is machine learning?' });
    await conv.addMessage({ role: 'assistant', content: 'Machine learning is a subset of AI…',
      sources: [{ documentTitle: 'AI Textbook', pageNumber: 12, score: 0.92 }] });
    pass('Added user and assistant messages via addMessage()');

    // Retrieve and check auto-title
    const found = await Conversation.findById(convId);
    if (!found) throw new Error('Conversation not found after create');
    pass(`Retrieved conversation  messages=${found.messages.length}  title="${found.title}"`);

    if (found.messages[1].sources.length > 0) {
      pass('Assistant message sources stored correctly');
    } else {
      fail('Sources', new Error('sources array is empty'));
    }

  } catch (err) {
    fail('Conversation test', err);
  } finally {
    if (convId) {
      await Conversation.findByIdAndDelete(convId);
      pass('Cleaned up test conversation');
    }
  }
};

// ── Runner ────────────────────────────────────────────────────────────────────
const run = async () => {
  console.log('\n🧪  University AI Chatbot — Model Tests');
  console.log('    Connecting to MongoDB Atlas…\n');

  try {
    await connectDB();
  } catch (err) {
    console.error('💥  Could not connect to MongoDB:', err.message);
    process.exit(1);
  }

  // Run tests sequentially so IDs flow between them
  const userId = await testUser();
  const docId  = await testDocument(userId);
  await testDocumentChunk(docId);
  await testConversation(userId);

  // Final cleanup: remove the test document (chunks already cleaned inside their test)
  if (docId) {
    await Document.findByIdAndDelete(docId);
    console.log('\n  🗑   Test document removed.');
  }

  console.log('\n✅  All model tests completed.\n');
  await disconnectDB();
  process.exit(0);
};

run();
