// Simple test script for the generate-text API
const testGenerateText = async () => {
  try {
    const response = await fetch('http://localhost:3002/api/generate-text', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        system: 'You are a helpful assistant.',
        messages: [{ role: 'user', content: 'Hello, how are you?' }],
        temperature: 0.5,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    console.log('✅ API Response:', data);
  } catch (error) {
    console.error('❌ Error testing API:', error);
  }
};

// Run the test
testGenerateText();
