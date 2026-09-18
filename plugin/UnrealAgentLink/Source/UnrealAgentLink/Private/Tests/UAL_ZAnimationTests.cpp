#include "Misc/AutomationTest.h"
#include "Misc/EngineVersionComparison.h"
#if WITH_DEV_AUTOMATION_TESTS && !UE_VERSION_OLDER_THAN(5, 5, 0)
#include "Animation/AnimSequence.h"
#include "Animation/Skeleton.h"
#include "Animation/AnimData/IAnimationDataController.h"
#include "Animation/AnimData/IAnimationDataModel.h"
#include "Dom/JsonObject.h"
#include "ReferenceSkeleton.h"
#include "Misc/CommandLine.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonSerializer.h"

namespace UALAnimation
{
    TSharedPtr<FJsonObject> MeasureSequence(UAnimSequence* Anim, const TSharedPtr<FJsonObject>& Input, FString& Error);
    TSharedPtr<FJsonObject> WritePoseSequence(UAnimSequence* Target, UAnimSequence* Source, const TSharedPtr<FJsonObject>& Input, FString& Error);
    TSharedPtr<FJsonObject> PreviewAsset(const TSharedPtr<FJsonObject>& Input, FString& Error);
    TSharedPtr<FJsonObject> RetargetAsset(const TSharedPtr<FJsonObject>& Input, FString& Error);
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUALAnimationMeasurements, "UnrealAgentLink.Animation.Measurements",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUALAnimationMeasurements::RunTest(const FString& Parameters)
{
    USkeleton* Skeleton = NewObject<USkeleton>();
    TArray<FName> Names = {TEXT("root"), TEXT("pelvis"), TEXT("spine_05"), TEXT("head"), TEXT("clavicle_l"), TEXT("clavicle_r"),
        TEXT("upperarm_l"), TEXT("lowerarm_l"), TEXT("hand_l"), TEXT("thigh_l"), TEXT("calf_l"), TEXT("foot_l"), TEXT("ball_l")};
    const double Knee = FMath::DegreesToRadians(21.0);
    const FVector Foot(40 * FMath::Sin(Knee), -10, 50 - 40 * FMath::Cos(Knee));
    TArray<FVector> Positions = {FVector::ZeroVector, FVector(0, 0, 100), FVector(0, 0, 140), FVector(0, 0, 175),
        FVector(0, -10, 150), FVector(0, 10, 150), FVector(0, -20, 145),
        FVector(0, -20 - 30 * FMath::Sin(FMath::DegreesToRadians(36.0)), 145 - 30 * FMath::Cos(FMath::DegreesToRadians(36.0))),
        FVector(0, -50, 100), FVector(0, -10, 90), FVector(0, -10, 50), Foot, Foot + FVector(15, 0, 0)};
    {
        FReferenceSkeletonModifier Modifier(Skeleton);
        for (int32 I = 0; I < Names.Num(); ++I)
            Modifier.Add(FMeshBoneInfo(Names[I], Names[I].ToString(), I == 0 ? INDEX_NONE : 0), FTransform(Positions[I]));
    }
    UAnimSequence* Animation = NewObject<UAnimSequence>();
    Animation->SetSkeleton(Skeleton);
    IAnimationDataController& Controller = Animation->GetController();
    Controller.InitializeModel();
    Controller.OpenBracket(FText::FromString(TEXT("Synthetic measurements")), false);
    Controller.SetFrameRate(FFrameRate(30, 1), false);
    Controller.SetNumberOfFrames(10, false);
    for (int32 B = 0; B < Names.Num(); ++B)
    {
        Controller.AddBoneCurve(Names[B], false);
        TArray<FVector3f> P, S; TArray<FQuat4f> Q;
        for (int32 Frame = 0; Frame <= 10; ++Frame)
        {
            FVector Position = Positions[B];
            FQuat Rotation = FQuat::Identity;
            if (Names[B] == TEXT("head")) Rotation = FRotator(-10.5, 0, 0).Quaternion();
            if (Names[B] == TEXT("pelvis")) Position.Z += 4.1 * Frame / 10.0;
            if (Names[B] == TEXT("spine_05")) Position.Z += 2.3 * Frame / 10.0;
            if (Names[B] == TEXT("hand_l") && Frame == 10) Position.X += 25;
            if (Names[B] == TEXT("ball_l")) Position = Foot + FRotator(0, 11, 0).RotateVector(FVector(15, 0, 0));
            P.Add(FVector3f(Position)); Q.Add(FQuat4f(Rotation)); S.Add(FVector3f::OneVector);
        }
        Controller.SetBoneTrackKeys(Names[B], P, Q, S, false);
    }
    Controller.NotifyPopulated(); Controller.CloseBracket(false);
    FString Error;
    TSharedPtr<FJsonObject> Input = MakeShared<FJsonObject>();
    const auto Result = UALAnimation::MeasureSequence(Animation, Input, Error);
    if (!TestTrue(TEXT("Measurement succeeds: ") + Error, Result.IsValid())) return false;
    const auto Metrics = Result->GetObjectField(TEXT("metrics"));
    auto Check = [this](const TCHAR* Name, double Actual, double Expected) { TestTrue(Name, FMath::IsNearlyEqual(Actual, Expected, 0.1)); };
    Check(TEXT("Elbow 36"), Metrics->GetObjectField(TEXT("elbow_out_deg"))->GetObjectField(TEXT("l"))->GetNumberField(TEXT("max")), 36);
    Check(TEXT("Toe -11"), Metrics->GetObjectField(TEXT("toe_out_deg"))->GetObjectField(TEXT("l"))->GetNumberField(TEXT("max")), -11);
    Check(TEXT("Knee 21"), Metrics->GetObjectField(TEXT("knee_bend_deg"))->GetObjectField(TEXT("l"))->GetNumberField(TEXT("max")), 21);
    Check(TEXT("Head -10.5"), Metrics->GetObjectField(TEXT("gaze_pitch_deg"))->GetNumberField(TEXT("max")), -10.5);
    Check(TEXT("Pelvis range 4.1"), Metrics->GetObjectField(TEXT("vertical_range_cm"))->GetNumberField(TEXT("pelvis_range")), 4.1);
    Check(TEXT("Torso 0"), Metrics->GetObjectField(TEXT("torso_yaw_deg"))->GetNumberField(TEXT("max")), 0);
    Check(TEXT("Hand jump 25"), Metrics->GetObjectField(TEXT("hand_step_cm"))->GetObjectField(TEXT("l"))->GetNumberField(TEXT("max")), 25);
    TestEqual(TEXT("Jump frame"), Metrics->GetObjectField(TEXT("hand_step_cm"))->GetObjectField(TEXT("l"))->GetIntegerField(TEXT("max_frame")), 10);
    TestEqual(TEXT("Missing right hand is not zero"), Metrics->GetObjectField(TEXT("hand_step_cm"))->GetObjectField(TEXT("r"))->GetStringField(TEXT("status")), FString(TEXT("unmeasurable")));

    TArray<FVector3f> P, S; TArray<FQuat4f> Q;
    P.Init(FVector3f(0, 0, 100), 11); S.Init(FVector3f::OneVector, 11); Q.Init(FQuat4f(FRotator(0, 90, 0).Quaternion()), 11);
    Controller.SetBoneTrackKeys(TEXT("pelvis"), P, Q, S, false);
    const auto Turned = UALAnimation::MeasureSequence(Animation, Input, Error);
    TestEqual(TEXT("Turning cannot be called toe-out"), Turned->GetObjectField(TEXT("metrics"))->GetObjectField(TEXT("toe_out_deg"))->GetObjectField(TEXT("l"))->GetStringField(TEXT("status")), FString(TEXT("unmeasurable")));

    // A wrist twist leaves the seven positional summaries unchanged but must still be written and verified.
    UAnimSequence* Target = DuplicateObject<UAnimSequence>(Animation, GetTransientPackage());
    TArray<FTransform> Before;
    Target->GetDataModel()->GetBoneTrackTransforms(TEXT("hand_l"), Before);
    P.Init(FVector3f(0, -50, 100), 11); Q.Init(FQuat4f(FRotator(0, 0, 47).Quaternion()), 11);
    Controller.SetBoneTrackKeys(TEXT("hand_l"), P, Q, S, false);
    auto WriteInput = MakeShared<FJsonObject>();
    WriteInput->SetNumberField(TEXT("source_time"), 0);
    WriteInput->SetNumberField(TEXT("start_frame"), 4);
    WriteInput->SetNumberField(TEXT("end_frame"), 6);
    WriteInput->SetNumberField(TEXT("transition_frames"), 1);
    const auto Written = UALAnimation::WritePoseSequence(Target, Animation, WriteInput, Error);
    if (!TestTrue(TEXT("Pose write succeeds: ") + Error, Written.IsValid())) return false;
    TArray<FTransform> After;
    Target->GetDataModel()->GetBoneTrackTransforms(TEXT("hand_l"), After);
    const FTransform Expected(FRotator(0, 0, 47), FVector(0, -50, 100));
    for (int32 Frame = 0; Frame <= 10; ++Frame)
    {
        FTransform Wanted = Before[Frame];
        if (Frame >= 4 && Frame <= 6) Wanted = Expected;
        else if (Frame == 3 || Frame == 7) Wanted.Blend(Before[Frame], Expected, 0.5);
        TestTrue(FString::Printf(TEXT("Wrist local transform frame %d"), Frame), After[Frame].Equals(Wanted, 0.0001));
    }
    WriteInput->SetNumberField(TEXT("end_frame"), 99999);
    TestFalse(TEXT("Out-of-range write rejected"), UALAnimation::WritePoseSequence(Target, Animation, WriteInput, Error).IsValid());

    // Optional manual integration fixture: UE's ThirdPerson Characters copied to this test project's Content/Characters.
    // The synthetic assertions above always run; this additionally requires rendering and the template assets.
    if (FParse::Param(FCommandLine::Get(), TEXT("UALAnimationTemplateSmoke")))
    {
        const FString SourcePath = TEXT("/Game/Characters/Mannequins/Animations/Manny/MM_Idle.MM_Idle");
        auto RetargetInput = MakeShared<FJsonObject>();
        RetargetInput->SetStringField(TEXT("source_mesh"), TEXT("/Game/Characters/Mannequins/Meshes/SKM_Manny.SKM_Manny"));
        RetargetInput->SetStringField(TEXT("target_mesh"), TEXT("/Game/Characters/Mannequins/Meshes/SKM_Quinn.SKM_Quinn"));
        RetargetInput->SetStringField(TEXT("animation"), SourcePath);
        RetargetInput->SetStringField(TEXT("output_path"), TEXT("/Game/AnimationAcceptance/Idle_") + FGuid::NewGuid().ToString(EGuidFormats::Digits));
        const auto Retargeted = UALAnimation::RetargetAsset(RetargetInput, Error);
        if (!TestTrue(TEXT("Template retarget: ") + Error, Retargeted.IsValid())) return false;
        auto PreviewInput = MakeShared<FJsonObject>();
        PreviewInput->SetStringField(TEXT("mesh"), TEXT("/Game/Characters/Mannequins/Meshes/SKM_Quinn.SKM_Quinn"));
        PreviewInput->SetStringField(TEXT("animation"), Retargeted->GetStringField(TEXT("path")));
        PreviewInput->SetNumberField(TEXT("time"), 0);
        PreviewInput->SetStringField(TEXT("camera"), TEXT("three_quarter"));
        const auto Preview = UALAnimation::PreviewAsset(PreviewInput, Error);
        if (!TestTrue(TEXT("Template preview: ") + Error, Preview.IsValid())) return false;
        auto Evidence = MakeShared<FJsonObject>();
        Evidence->SetObjectField(TEXT("retarget"), Retargeted);
        Evidence->SetObjectField(TEXT("preview"), Preview);
        UAnimSequence* Output = LoadObject<UAnimSequence>(nullptr, *Retargeted->GetStringField(TEXT("path")));
        const auto Measured = UALAnimation::MeasureSequence(Output, Input, Error);
        if (!TestTrue(TEXT("Retargeted animation can be measured"), Measured.IsValid())) return false;
        Evidence->SetObjectField(TEXT("measure"), Measured);
        // Explicit reuse must preserve the existing retarget configuration.
        RetargetInput->SetStringField(TEXT("retargeter"), Retargeted->GetStringField(TEXT("retargeter")));
        RetargetInput->SetStringField(TEXT("output_path"), TEXT("/Game/AnimationAcceptance/Reuse_") + FGuid::NewGuid().ToString(EGuidFormats::Digits));
        const auto Reused = UALAnimation::RetargetAsset(RetargetInput, Error);
        if (!TestTrue(TEXT("Existing retargeter reuse: ") + Error, Reused.IsValid())) return false;
        Evidence->SetObjectField(TEXT("reuse"), Reused);
        FString Json;
        FJsonSerializer::Serialize(Evidence, TJsonWriterFactory<>::Create(&Json));
        TestTrue(TEXT("Write manual acceptance evidence"), FFileHelper::SaveStringToFile(Json, *(FPaths::ProjectSavedDir() / TEXT("animation-evidence.json"))));
    }
    return true;
}
#endif
