import joblib

model = None

def load_formality_model(path: str):
    global model
    try:
        print("Loading formality model...")
        model = joblib.load(path)  # ✅ use joblib instead of pickle
        print("Formality model loaded successfully!")
    except Exception as e:
        print(f"Failed to load formality model: {e}")
        model = None

def predict_formality(text: str) -> str:
    if model is None:
        return "Model not loaded"
    try:
        prediction = model.predict([text])[0]
        return str(prediction)
    except Exception as e:
        print(f"Prediction error: {e}")
        return "Error during prediction"